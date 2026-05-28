/**
 * eval-recommendation-cli.ts — 推荐质量离线评测 CLI
 *
 * 用法：
 *   npx tsx src/cli/eval-recommendation-cli.ts [--query-set offline_eval/query_set.jsonl] [--limit 10] [--output offline_eval/results/]
 *
 * 输出：
 *   - stdout: 评测摘要（Recall@10 / Recall@50 / MRR@10 / nDCG@10）
 *   - results/<date>.jsonl: 每条 query 的详细结果 + 失败分类
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { RecommendationService } from '../services/recommendationService.js';
import { SymbolRepository } from '../repositories/symbolRepository.js';
import { classifySymbolFailure } from '../types/evalTrace.js';
import type { EvalTrace, SymbolFailureType } from '../types/evalTrace.js';
import type { RecommendComponentInput } from '../services/recommendationService.js';

// ─── CLI 参数 ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag: string, fallback: string): string {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? (args[idx + 1] as string) : fallback;
}

const QUERY_SET_PATH = getArg('--query-set', 'offline_eval/query_set.jsonl');
const OUTPUT_DIR = getArg('--output', 'offline_eval/results');
const TOP_K_MAIN = Number(getArg('--limit', '10')); // Recall@K_MAIN / MRR@K / nDCG@K
const RECALL_WIDE_K = 50; // 宽口径召回深度（用于 Recall@50），不是测试集数量
const REL_RELEVANT_MIN = 1; // rel >= 1 计入相关结果
const REL_PRIMARY = 2; // rel = 2 表示主答案/最高相关度

// ─── 数据类型 ─────────────────────────────────────────────────────────────────

interface ExpectedSymbol {
    name: string;
    path: string;
    rel: 0 | 1 | 2;
}

interface QueryCase {
    id: string;
    input: Omit<RecommendComponentInput, 'evalMode' | 'limit'>;
    expected: ExpectedSymbol[];
    tags: string[];
}

interface SymbolFailureDetail {
    name: string;
    expectedPath: string;
    type: SymbolFailureType;
}

interface QueryResult {
    queryId: string;
    query: string;
    tags: string[];
    recallMain: number | null; // null = no expected (negative sample)
    recall50: number | null;
    firstHitScore: number | null; // 首位命中率：第一个正确结果在第几位（MRR@10）
    // rankingQuality: number | null; // 排序质量：综合考虑位置与相关度的整体排名得分（nDCG@10）
    top1Correct: boolean | null;
    returnedNames: string[];
    failures: SymbolFailureDetail[];
    isNegativeSample: boolean;
    falsePositive: boolean; // negative sample but returned results
}

// ─── 指标计算 ─────────────────────────────────────────────────────────────────

/**
 * 覆盖率 Recall@K：前 K 条结果中命中的相关条目占全部相关条目的比例。
 * 衡量「应该找到的有多少被找到了」，与排名顺序无关。
 * 负例（expected 全为 rel=0）视为完全命中，返回 1。
 */
function recallAtK(
    returnedNames: string[],
    expected: ExpectedSymbol[],
    k: number
): number {
    const relevant = expected.filter((e) => e.rel >= REL_RELEVANT_MIN);
    if (relevant.length === 0) return 1;
    const topK = returnedNames.slice(0, k);
    const hits = relevant.filter((e) => topK.includes(e.name));
    // 召回率@k = 真实召回的 / 所有相关的
    return hits.length / relevant.length;
}

/**
 * 倒数排名均值 MRR@K（Mean Reciprocal Rank）：第一个相关结果出现在第 r 位时得分为 1/r。
 * 衡量「最佳结果排多靠前」；未命中则返回 0。
 */
function mrrAtK(
    returnedNames: string[],
    expected: ExpectedSymbol[],
    k: number
): number {
    const relevantNames = new Set(
        expected.filter((e) => e.rel >= REL_RELEVANT_MIN).map((e) => e.name)
    );
    const topK = returnedNames.slice(0, k);
    for (let i = 0; i < topK.length; i++) {
        // 有一个命中的 就返回对应的 MRR 分数，越靠前分数越高；如果都没命中，最后返回 0。
        if (relevantNames.has(topK[i] as string)) return 1 / (i + 1);
    }
    return 0;
}

/**
 * 归一化折损累积增益 nDCG@K（Normalized Discounted Cumulative Gain）：综合考虑相关度分级（rel 0/1/2）
 * 与排名位置的加权得分，再除以理想排序下的最大得分做归一化。
 * 越靠前、相关度越高的结果得分越高；完全理想排序时返回 1。
 */
function ndcgAtK(
    returnedNames: string[],
    expected: ExpectedSymbol[],
    k: number
): number {
    const relMap = new Map(expected.map((e) => [e.name, e.rel]));
    const topK = returnedNames.slice(0, k);

    const dcg = topK.reduce((sum, name, idx) => {
        const rel = relMap.get(name) ?? 0;
        return sum + (Math.pow(2, rel) - 1) / Math.log2(idx + 2);
    }, 0);

    const idealRels: number[] = expected
        .map((e) => e.rel as number)
        .sort((a, b) => b - a)
        .slice(0, k);
    const idcg = idealRels.reduce((sum, rel, idx) => {
        return sum + (Math.pow(2, rel) - 1) / Math.log2(idx + 2);
    }, 0);

    return idcg === 0 ? 1 : dcg / idcg;
}

/**
 * 返回失败阶段原因数组（无 ID 时按名称降级处理）
 */
function classifyFailuresFromTrace(
    expected: ExpectedSymbol[],
    returnedNames: string[],
    evalTrace: EvalTrace | undefined,
    idByName: Map<string, number>
): SymbolFailureDetail[] {
    const relevant = expected.filter((e) => e.rel >= REL_RELEVANT_MIN);
    const failures: SymbolFailureDetail[] = [];

    for (const exp of relevant) {
        if (returnedNames.includes(exp.name)) continue;

        const id = idByName.get(exp.name);
        if (evalTrace !== undefined && id !== undefined) {
            const failType = classifySymbolFailure(id, evalTrace);
            if (failType !== 'found') {
                failures.push({
                    name: exp.name,
                    expectedPath: exp.path,
                    type: failType,
                });
            }
        } else {
            // DB 中无此 symbol，降级为 no_semantic_recall
            failures.push({
                name: exp.name,
                expectedPath: exp.path,
                type: 'no_semantic_recall',
            });
        }
    }
    return failures;
}

// ─── ID 解析（从返回结果中建立 name→id 映射） ────────────────────────────────

function buildIdMapFromResult(
    recommended: { id: number; name: string } | null,
    alternatives: Array<{ id: number; name: string }>
): Map<string, number> {
    const map = new Map<string, number>();
    if (recommended) map.set(recommended.name, recommended.id);
    alternatives.forEach((a) => map.set(a.name, a.id));
    return map;
}

// ─── 汇总统计 ─────────────────────────────────────────────────────────────────

function avg(nums: number[]): number {
    if (nums.length === 0) return 0;
    return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function formatPct(n: number): string {
    return (n * 100).toFixed(1) + '%';
}

function printSummary(
    results: QueryResult[],
    kMain: number,
    baseline: Record<string, number> | null
): void {
    const positive = results.filter((r) => !r.isNegativeSample);
    const negative = results.filter((r) => r.isNegativeSample);

    const recallMain = avg(positive.map((r) => r.recallMain ?? 0));
    const recall50 = avg(positive.map((r) => r.recall50 ?? 0));
    const firstHitScore = avg(positive.map((r) => r.firstHitScore ?? 0));
    // const rankingQuality = avg(positive.map((r) => r.rankingQuality ?? 0));
    const coverage =
        positive.filter((r) => (r.recallMain ?? 0) > 0).length /
        (positive.length || 1);
    const top1Acc =
        positive.filter((r) => r.top1Correct === true).length /
        (positive.length || 1);
    const fpRate =
        negative.filter((r) => r.falsePositive).length / (negative.length || 1);

    const diff = (metric: string, val: number): string => {
        if (!baseline || !(metric in baseline)) return '';
        const delta = val - (baseline[metric] as number);
        return delta >= 0
            ? ` (+${formatPct(delta)})`
            : ` (${formatPct(delta)})`;
    };

    console.log('\n' + '='.repeat(60));
    console.log(
        `=== Eval Report  ${new Date().toISOString().slice(0, 10)} ===`
    );
    console.log('='.repeat(60));
    console.log(
        `Queries total:  ${results.length}  (positive: ${positive.length}, negative: ${negative.length})`
    );
    console.log('');
    console.log(
        `召回率(Recall@${kMain}):         ${formatPct(recallMain)}${diff('recallMain', recallMain)}`
    );
    console.log(
        `首位命中分(MRR@${kMain}):         ${formatPct(firstHitScore)}${diff('firstHitScore', firstHitScore)}`
    );
    console.log(
        `首条准确率(Top-1):               ${formatPct(top1Acc)}${diff('top1Acc', top1Acc)}`
    );
    console.log(
        `误触率(FP):                      ${formatPct(fpRate)}  (负例被错误推荐)`
    );
    console.log('');

    // ── Failure breakdown ──
    const allFailures = positive.flatMap((r) => r.failures);
    const failureCounts: Record<SymbolFailureType, number> = {
        no_semantic_recall: 0,
        reusability_filtered: 0,
        structure_filtered: 0,
        ranked_below_topk: 0,
        quality_gate_rejected: 0,
        found: 0,
    };
    for (const f of allFailures) failureCounts[f.type]++;
    const totalExpected = positive.reduce(
        (s, r) => s + r.failures.length + (r.recallMain === 1 ? 1 : 0),
        0
    );

    console.log('--- Failure Breakdown ---');
    const failureActionHints: Record<SymbolFailureType, string> = {
        no_semantic_recall: '→ 调大 SYMBOL_TOP_K / 增加 queryVariants 数量',
        reusability_filtered: '→ 检查 isReusableCandidate 路径规则是否误杀',
        structure_filtered: '→ 检查 category 过滤条件',
        ranked_below_topk: '→ 调整 RANK_WEIGHTS / LITERAL_MATCH_PRIORITY_BOOST',
        quality_gate_rejected: '→ 调低 MIN_RECOMMENDATION_SCORE 阈值',
        found: '',
    };
    for (const [type, count] of Object.entries(failureCounts)) {
        if (type === 'found') continue;
        const pct =
            totalExpected > 0
                ? ((count / totalExpected) * 100).toFixed(1)
                : '0.0';
        const hint = failureActionHints[type as SymbolFailureType];
        console.log(
            `  ${type.padEnd(26)} ${String(count).padStart(3)} (${pct}%)  ${hint}`
        );
    }
    console.log('='.repeat(60) + '\n');
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

async function loadQuerySet(filePath: string): Promise<QueryCase[]> {
    const cases: QueryCase[] = [];
    const rl = readline.createInterface({
        input: fs.createReadStream(filePath),
        crlfDelay: Infinity,
    });
    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
        cases.push(JSON.parse(trimmed) as QueryCase);
    }
    return cases;
}

async function runEval(): Promise<void> {
    console.log(`Loading query set: ${QUERY_SET_PATH}`);
    const cases = await loadQuerySet(QUERY_SET_PATH);
    console.log(
        `Loaded ${cases.length} queries. Running eval with limit=${TOP_K_MAIN}/${RECALL_WIDE_K}...\n`
    );

    const repository = new SymbolRepository();
    const service = new RecommendationService(repository);
    const results: QueryResult[] = [];

    for (const queryCase of cases) {
        const isNegative = queryCase.expected.length === 0;

        const wideResult = await service.recommendComponent({
            ...queryCase.input,
            limit: RECALL_WIDE_K,
            evalMode: true,
        });

        const wideNames: string[] = [
            ...(wideResult.recommended ? [wideResult.recommended.name] : []),
            ...wideResult.alternatives.map((a) => a.name),
        ];

        const mainNames = wideNames.slice(0, TOP_K_MAIN);

        const allReturned = [
            ...(wideResult.recommended ? [wideResult.recommended] : []),
            ...wideResult.alternatives,
        ];
        const idByName = buildIdMapFromResult(
            wideResult.recommended,
            wideResult.alternatives
        );

        const recallMain = isNegative
            ? null
            : recallAtK(mainNames, queryCase.expected, TOP_K_MAIN);
        const recall50 = isNegative
            ? null
            : recallAtK(wideNames, queryCase.expected, RECALL_WIDE_K);
        const firstHitRank = isNegative
            ? null
            : mrrAtK(mainNames, queryCase.expected, TOP_K_MAIN);
        // const rankingQuality = isNegative
        //     ? null
        //     : ndcgAtK(mainNames, queryCase.expected, TOP_K_MAIN);
        const top1Correct = isNegative
            ? null
            : queryCase.expected.some(
                  (e) =>
                      e.rel === REL_PRIMARY &&
                      wideResult.recommended?.name === e.name
              );

        const failures = isNegative
            ? []
            : classifyFailuresFromTrace(
                  queryCase.expected,
                  wideNames,
                  wideResult.evalTrace,
                  idByName
              );

        const falsePositive = isNegative && allReturned.length > 0;

        const qr: QueryResult = {
            queryId: queryCase.id,
            query: queryCase.input.query,
            tags: queryCase.tags,
            recallMain,
            recall50,
            firstHitScore: firstHitRank,
            // rankingQuality,
            top1Correct,
            returnedNames: mainNames,
            failures,
            isNegativeSample: isNegative,
            falsePositive,
        };
        results.push(qr);

        const status = isNegative
            ? falsePositive
                ? '✗ False Positive）' // 负例，但系统返回了结果 → 误触发（False Positive）
                : '✓ True Negative' // 负例，系统正确返回空   → 真负例（True Negative）
            : recallMain === 1
              ? `✓ R@${TOP_K_MAIN}=1.0 完全召回`
              : `✗ R@${TOP_K_MAIN}=${(recallMain ?? 0).toFixed(2)} 不完全召回`;
        console.log(
            `  [${queryCase.id}] ${queryCase.input.query.slice(0, 40).padEnd(40)}  ${status}`
        );
    }

    printSummary(results, TOP_K_MAIN, null);

    if (OUTPUT_DIR) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        const dateStr = new Date().toISOString().slice(0, 10);
        const outPath = path.join(OUTPUT_DIR, `${dateStr}.jsonl`);
        const lines = results.map((r) => JSON.stringify(r)).join('\n');
        fs.writeFileSync(outPath, lines + '\n', 'utf8');
        console.log(`Report written to: ${outPath}`);
    }

    // 如果有正例查询完全没有召回任何相关结果，视为严重问题，输出警告并退出非 0 状态码以示 CI 失败。
    const zeroRecall = results.filter(
        (r) => !r.isNegativeSample && r.recallMain === 0
    );
    if (zeroRecall.length > 0) {
        console.log(
            `\nWARN: ${zeroRecall.length} positive queries have Recall@${TOP_K_MAIN}=0:`
        );
        for (const r of zeroRecall) {
            console.log(`  [${r.queryId}] ${r.query}`);
        }
        process.exit(1);
    }
}

runEval().catch((err: unknown) => {
    console.error('Eval failed:', err);
    process.exit(1);
});
