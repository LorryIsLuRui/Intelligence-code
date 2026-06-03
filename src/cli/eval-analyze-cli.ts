/**
 * eval-analyze-cli.ts — 离线评测结果分析工具
 *
 * 用法：
 *   npm run analyze                             # 自动读取 offline_eval/results/ 最新文件
 *   npm run analyze -- offline_eval/results/2026-05-27.jsonl
 *   npm run analyze -- --dir offline_eval/results --baseline offline_eval/results/2026-05-26.jsonl
 *
 * 输出：
 *   - 关键指标汇总（含与 baseline 对比 delta）
 *   - 按语言/符号类型分组 Recall@10
 *   - 失败归因分布
 *   - 主要发现（自动检测中英文差距、类型推断问题、误触等）
 *   - 建议优先级列表
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

// ─── CLI 参数 ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string, fallback: string): string {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? (args[idx + 1] as string) : fallback;
}

const RESULTS_DIR = getArg('--dir', 'offline_eval/results');
const BASELINE_PATH = getArg('--baseline', '');

// ─── 分析阈值（可按实际结果微调） ────────────────────────────────────────────

const THRESHOLDS = {
    /** 中英文 Recall@10 差距超过此值时触发"中文召回偏弱"发现 */
    ZH_EN_RECALL_GAP: 0.1,
    /** 函数类 Recall@10 低于此值时触发"函数类型推断"发现 */
    FUNC_RECALL_LOW: 0.5,
    /** no_semantic_recall 占比超过此值时触发"归因主导"发现 */
    NO_SEMANTIC_DOMINANCE: 0.5,
    /** no_semantic_recall 占比超过此值时输出归因修正建议 */
    NO_SEMANTIC_REC_TRIGGER: 0.3,
    /** quality_gate_rejected 条数超过此值时输出质量门控建议 */
    QG_COUNT_MIN: 2,
    /** ranked_below_topk 条数超过此值时输出排名调整建议 */
    RANKED_COUNT_MIN: 1,
    /** 终端横向进度条宽度（字符数） */
    BAR_WIDTH: 20,
    /** 中文零召回示例最多展示条数 */
    ZH_ZERO_EXAMPLE_LIMIT: 4,
    /** 误触示例最多展示条数 */
    FP_EXAMPLE_LIMIT: 3,
} as const;

function findLatestResultsFile(): string {
    // 支持直接传路径（不带 flag）
    const explicit = args.find(
        (a) => a.endsWith('.jsonl') && !a.startsWith('--')
    );
    if (explicit) return explicit;

    if (!fs.existsSync(RESULTS_DIR)) {
        throw new Error(`Results directory not found: ${RESULTS_DIR}`);
    }

    const files = fs
        .readdirSync(RESULTS_DIR)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .reverse();

    if (files.length === 0) {
        throw new Error(`No .jsonl result files found in ${RESULTS_DIR}`);
    }

    return path.join(RESULTS_DIR, files[0] as string);
}

// ─── 数据类型 ─────────────────────────────────────────────────────────────────

interface FailureDetail {
    name: string;
    expectedPath: string;
    type: string;
}

interface QueryResult {
    queryId: string;
    query: string;
    tags: string[];
    recallMain: number | null;
    recall50: number | null;
    firstHitScore: number | null;
    rankingQuality: number | null;
    top1Correct: boolean | null;
    returnedNames: string[];
    failures: FailureDetail[];
    isNegativeSample: boolean;
    falsePositive: boolean;
}

// ─── 文件加载 ─────────────────────────────────────────────────────────────────

async function loadResults(filePath: string): Promise<QueryResult[]> {
    const results: QueryResult[] = [];
    const rl = readline.createInterface({
        input: fs.createReadStream(filePath),
        crlfDelay: Infinity,
    });
    for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed) results.push(JSON.parse(trimmed) as QueryResult);
    }
    return results;
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/**
 * 计算平均值，空数组时返回 0。
 */
function avg(nums: number[]): number {
    if (nums.length === 0) return 0;
    return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function pct(n: number): string {
    return (n * 100).toFixed(1) + '%';
}

function delta(curr: number, base: number | undefined): string {
    if (base === undefined) return '';
    const d = curr - base;
    const sign = d >= 0 ? '+' : '';
    return ` (${sign}${pct(d)})`;
}

function recallByTag(
    results: QueryResult[],
    tag: string
): { recall: number; count: number } {
    const tagged = results.filter(
        (r) => !r.isNegativeSample && r.tags.includes(tag)
    );
    return {
        recall: avg(tagged.map((r) => r.recallMain ?? 0)),
        count: tagged.length,
    };
}

interface SummaryMetrics {
    recallMain: number;
    recall50: number;
    firstHitScore: number; // 首位命中分（MRR@10，Mean Reciprocal Rank）
    rankingQuality: number; // 排序质量（nDCG@10）
    coverage: number; // 有效覆盖率
    top1Acc: number;
    fpRate: number;
}

/**
 * 计算各项指标的平均值，返回一个汇总对象。
 */
function computeMetrics(
    positive: QueryResult[],
    negative: QueryResult[]
): SummaryMetrics {
    return {
        recallMain: avg(positive.map((r) => r.recallMain ?? 0)),
        recall50: avg(positive.map((r) => r.recall50 ?? 0)),
        firstHitScore: avg(positive.map((r) => r.firstHitScore ?? 0)),
        rankingQuality: avg(positive.map((r) => r.rankingQuality ?? 0)),
        coverage:
            positive.filter((r) => (r.recallMain ?? 0) > 0).length /
            (positive.length || 1),
        top1Acc:
            positive.filter((r) => r.top1Correct === true).length /
            (positive.length || 1),
        fpRate:
            negative.filter((r) => r.falsePositive).length /
            (negative.length || 1),
    };
}

// ─── 主分析逻辑 ───────────────────────────────────────────────────────────────

async function analyze(): Promise<void> {
    const filePath = findLatestResultsFile();
    const fileName = path.basename(filePath);

    const results = await loadResults(filePath);
    const positive = results.filter((r) => !r.isNegativeSample);
    const negative = results.filter((r) => r.isNegativeSample);

    const metrics = computeMetrics(positive, negative);

    // 如果不传 --baseline，baseMetrics 就是 undefined，delta() 函数返回空字符串，指标后面不显示涨跌。
    let baseMetrics: SummaryMetrics | undefined;
    if (BASELINE_PATH && fs.existsSync(BASELINE_PATH)) {
        const baseResults = await loadResults(BASELINE_PATH);
        const basePos = baseResults.filter((r) => !r.isNegativeSample);
        const baseNeg = baseResults.filter((r) => r.isNegativeSample);
        baseMetrics = computeMetrics(basePos, baseNeg);
    }

    // 失败归因统计
    const allFailures = positive.flatMap((r) => r.failures);
    const failureCounts: Record<string, number> = {};
    for (const f of allFailures) {
        failureCounts[f.type] = (failureCounts[f.type] ?? 0) + 1;
    }
    const totalFailures = allFailures.length;

    // 分组 Recall（按语言 + 类型标签）
    const tagGroups = [
        'en',
        'zh',
        'zh-en',
        'component',
        'hook',
        'function',
        'util',
        'form',
    ];
    const tagRecalls: Map<string, { recall: number; count: number }> =
        new Map();
    for (const tag of tagGroups) {
        const stat = recallByTag(positive, tag);
        if (stat.count > 0) tagRecalls.set(tag, stat);
    }

    // 零召回 query
    const zeroRecall = positive.filter((r) => r.recallMain === 0);

    // 误触（false positive）示例
    const fpExamples = negative.filter((r) => r.falsePositive);

    // ─── 输出报告 ──────────────────────────────────────────────────────────────

    const sep = '='.repeat(60);
    const sub = '─'.repeat(60);

    console.log('\n' + sep);
    console.log(`数据来源：${fileName}`);
    console.log(sep);

    // ── 关键指标 ──
    console.log('\n关键指标\n');
    console.log(
        `  召回率(Recall@10):             ${pct(metrics.recallMain).padStart(7)}${delta(metrics.recallMain, baseMetrics?.recallMain)}`
    );
    console.log(
        `  首位命中分(MRR@10):             ${pct(metrics.firstHitScore).padStart(7)}${delta(metrics.firstHitScore, baseMetrics?.firstHitScore)}`
    );
    console.log(
        `  首条准确率(Top-1):              ${pct(metrics.top1Acc).padStart(7)}${delta(metrics.top1Acc, baseMetrics?.top1Acc)}`
    );
    console.log(
        `  误触率(FP):                    ${pct(metrics.fpRate).padStart(7)}${delta(metrics.fpRate, baseMetrics?.fpRate)}`
    );
    console.log(
        `\n  总 query 数：${results.length}（正例 ${positive.length}，负例 ${negative.length}）`
    );

    // ── 分组 Recall ──
    console.log('\n' + sub);
    console.log('按语言/符号类型 Recall@10\n');
    for (const [tag, stat] of tagRecalls) {
        const bar = '█'
            .repeat(Math.round(stat.recall * THRESHOLDS.BAR_WIDTH))
            .padEnd(THRESHOLDS.BAR_WIDTH);
        console.log(
            `  ${tag.padEnd(12)} ${bar} ${pct(stat.recall).padStart(7)}  (${stat.count} queries)`
        );
    }

    // ── 失败归因 ──
    console.log('\n' + sub);
    console.log('失败归因分布\n');
    const failureActionHints: Record<string, string> = {
        no_semantic_recall:
            '→ 扩展 queryVariants / 中文同义词映射 / 调大 SYMBOL_TOP_K',
        quality_gate_rejected: '→ 按 type 降低质量门控阈值',
        ranked_below_topk: '→ 调整 RANK_WEIGHTS / LITERAL_MATCH_PRIORITY_BOOST',
        reusability_filtered: '→ 检查 isReusableCandidate 路径规则',
        structure_filtered: '→ 检查 category 过滤条件',
    };
    const sortedFailures = Object.entries(failureCounts).sort(
        (a, b) => b[1] - a[1]
    );
    for (const [type, count] of sortedFailures) {
        const p =
            totalFailures > 0
                ? ((count / totalFailures) * 100).toFixed(1)
                : '0.0';
        const hint = failureActionHints[type] ?? '';
        console.log(
            `  ${type.padEnd(28)} ${String(count).padStart(3)} (${p}%)  ${hint}`
        );
    }

    // ── 主要发现 ──
    console.log('\n' + sub);
    console.log('主要发现\n');

    const findings: string[] = [];

    // 发现1：中英文召回差距
    const zhStat = tagRecalls.get('zh');
    const enStat = tagRecalls.get('en');
    if (
        zhStat &&
        enStat &&
        enStat.recall - zhStat.recall > THRESHOLDS.ZH_EN_RECALL_GAP
    ) {
        const zhZero = positive
            .filter((r) => r.tags.includes('zh') && r.recallMain === 0)
            .map((r) => `"${r.query}"`)
            .slice(0, THRESHOLDS.ZH_ZERO_EXAMPLE_LIMIT);
        findings.push(
            `中文 query 召回明显弱于英文\n` +
                `   中文 Recall@10 = ${pct(zhStat.recall)}，英文 = ${pct(enStat.recall)}，差距 ${pct(enStat.recall - zhStat.recall)}\n` +
                `   零召回中文 query 示例：${zhZero.join('、')}`
        );
    }

    // 发现2：函数类类型推断
    const funcStat = tagRecalls.get('function');
    if (funcStat && funcStat.recall < THRESHOLDS.FUNC_RECALL_LOW) {
        findings.push(
            `函数类 query 召回偏低（Recall@10 = ${pct(funcStat.recall)}）\n` +
                `   可能原因：类型推断关键词缺少 function/formatter/validate，导致回退到 component 候选池`
        );
    }

    // 发现3：no_semantic_recall 主导
    const noSemanticCount = failureCounts['no_semantic_recall'] ?? 0;
    if (
        noSemanticCount / (totalFailures || 1) >
        THRESHOLDS.NO_SEMANTIC_DOMINANCE
    ) {
        findings.push(
            `失败以 no_semantic_recall 为主（${noSemanticCount}/${totalFailures} 条，${((noSemanticCount / (totalFailures || 1)) * 100).toFixed(0)}%）\n` +
                `   注意：该分类会掩盖 quality_gate_rejected 等更具体原因（当 DB 中无对应 id 时降级记录）`
        );
    }

    // 发现4：误触
    if (fpExamples.length > 0) {
        findings.push(
            `负例误触 ${fpExamples.length} 条（False Positive = ${pct(metrics.fpRate)}）\n` +
                `   示例：${fpExamples
                    .slice(0, THRESHOLDS.FP_EXAMPLE_LIMIT)
                    .map((r) => `"${r.query}"`)
                    .join('、')}`
        );
    }

    // 发现5：零召回 query 总数
    if (zeroRecall.length > 0) {
        const byTag = (tag: string) =>
            zeroRecall.filter((r) => r.tags.includes(tag)).length;
        findings.push(
            `${zeroRecall.length} 条正例 Recall@10 = 0\n` +
                `   其中 zh:${byTag('zh')}，en:${byTag('en')}，component:${byTag('component')}，hook:${byTag('hook')}，function:${byTag('function')}`
        );
    }

    findings.forEach((f, i) => console.log(`${i + 1}. ${f}\n`));

    // ── 建议优先级 ──
    console.log(sub);
    console.log('建议优先级（按预期收益排序）\n');

    const recs: Array<{ priority: string; action: string; reason: string }> =
        [];

    if (
        zhStat &&
        enStat &&
        enStat.recall - zhStat.recall > THRESHOLDS.ZH_EN_RECALL_GAP
    ) {
        recs.push({
            priority: '高',
            action: '强化中文同义词扩展（导航栏→navigation bar、日期格式化→format date 等）',
            reason: `中英召回差距 ${pct(enStat.recall - zhStat.recall)}，影响 ${zhStat.count} 条 query`,
        });
    }

    if (funcStat && funcStat.recall < THRESHOLDS.FUNC_RECALL_LOW) {
        recs.push({
            priority: '高',
            action: '补类型推断关键词（category: function、query: formatter/validate/format）',
            reason: `函数类 Recall@10 = ${pct(funcStat.recall)}，类型误判导致错误候选池`,
        });
    }

    if (
        noSemanticCount / (totalFailures || 1) >
        THRESHOLDS.NO_SEMANTIC_REC_TRIGGER
    ) {
        recs.push({
            priority: '中高',
            action: '修正 eval 失败归因逻辑（name+path 查 DB id，避免 no_semantic_recall 兜底掩盖）',
            reason: `${noSemanticCount} 条记为 no_semantic_recall，诊断精度不足`,
        });
    }

    const qgCount = failureCounts['quality_gate_rejected'] ?? 0;
    if (qgCount > THRESHOLDS.QG_COUNT_MIN) {
        recs.push({
            priority: '中高',
            action: '按 symbol type 分阈值降低质量门控（函数/Hook 可比组件更宽松）',
            reason: `${qgCount} 条被 quality gate 拦截`,
        });
    }

    const rankedCount = failureCounts['ranked_below_topk'] ?? 0;
    if (rankedCount > THRESHOLDS.RANKED_COUNT_MIN) {
        recs.push({
            priority: '中',
            action: '加强 index-priority tie-break（同目录 index/menu/panel 命中时强制 index 优先）',
            reason: `${rankedCount} 条有正确候选但排名未进 Top-K`,
        });
    }

    if (recs.length === 0) {
        recs.push({
            priority: '中',
            action: '持续扩充 query_set.jsonl 覆盖更多边界场景',
            reason: '当前指标已较好，可增加测试覆盖度',
        });
    }

    recs.forEach((r, i) => {
        console.log(`${i + 1}. [${r.priority}] ${r.action}`);
        console.log(`   原因：${r.reason}`);
        console.log();
    });

    console.log(sep + '\n');
}

analyze().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
