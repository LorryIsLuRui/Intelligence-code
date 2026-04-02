#!/usr/bin/env node
/**
 * PR/CI 用重复实现检测（最小版）
 *
 * 策略：
 * - 只分析 changed files 中可索引的导出代码块
 * - 与库内同 type 的存量代码块做语义相似度（cosine）匹配
 * - 对 component：要求 newProps 是 oldProps 的超集（或至少覆盖大部分）才判定为“重复/可合并”
 *
 * 输出：
 * - duplicate-report.json
 * - duplicate-report.md（中文，适合 PR 评论）
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { env, validateEnv } from '../config/env.js';
import { getMySqlPool } from '../db/mysql.js';
import { indexedRowToEmbedText } from '../indexer/embedText.js';
import { indexProject } from '../indexer/indexProject.js';
import {
    createEmbeddingClient,
    embedAll,
} from '../services/embeddingClient.js';
import { cosineSimilarity } from '../services/vectorMath.js';
import type { SymbolType } from '../types/symbol.js';

dotenv.config();

type DuplicateLevel = 'blocking' | 'warning';

type DuplicateFinding = {
    level: DuplicateLevel;
    symbol: {
        name: string;
        type: SymbolType;
        path: string;
        props: string[];
    };
    bestMatch: {
        id: number;
        name: string;
        type: SymbolType;
        path: string;
        similarity: number;
        props: string[];
        propsCoverage: number;
        propsIsSuperset: boolean;
    };
};

function parseArgs(argv: string[]) {
    const args = new Map<string, string>();
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        const value =
            argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
        args.set(key, value);
    }
    return args;
}

function readLines(path: string): string[] {
    const raw = readFileSync(path, 'utf8');
    return raw
        .split(/\r?\n/g)
        .map((l) => l.trim())
        .filter(Boolean);
}

function uniqueLower(items: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const it of items) {
        const k = it.trim();
        if (!k) continue;
        const low = k.toLowerCase();
        if (seen.has(low)) continue;
        seen.add(low);
        out.push(k);
    }
    return out;
}

function getMetaArray(
    meta: Record<string, unknown> | null | undefined,
    key: string
): string[] {
    if (!meta) return [];
    const v = meta[key];
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string');
}

function propsForRow(row: {
    type: SymbolType;
    meta: Record<string, unknown>;
}): string[] {
    if (row.type !== 'component') return [];
    return uniqueLower(getMetaArray(row.meta, 'props'));
}

function coverageAndSuperset(newProps: string[], oldProps: string[]) {
    if (oldProps.length === 0) {
        return { coverage: 1, isSuperset: true };
    }
    const newSet = new Set(newProps.map((p) => p.toLowerCase()));
    let hit = 0;
    for (const p of oldProps) {
        if (newSet.has(p.toLowerCase())) hit += 1;
    }
    const coverage = hit / oldProps.length;
    const isSuperset = hit === oldProps.length;
    return { coverage, isSuperset };
}

function toFixed4(n: number) {
    return Number(n.toFixed(4));
}

function escapeMd(text: string) {
    return text.replace(/\|/g, '\\|');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const changedFilesPath = args.get('changed-files') ?? 'changed_files.txt';
    const outJson = args.get('out-json') ?? 'duplicate-report.json';
    const outMd = args.get('out-md') ?? 'duplicate-report.md';
    const blockThreshold = Number(
        args.get('block-threshold') ??
            process.env.DUPLICATE_BLOCK_THRESHOLD ??
            '0.95'
    );
    const warnThreshold = Number(
        args.get('warn-threshold') ??
            process.env.DUPLICATE_WARN_THRESHOLD ??
            '0.85'
    );
    const propsCoverageThreshold = Number(args.get('props-coverage') ?? '1');
    const candidateLimit = Number(args.get('candidate-limit') ?? '3000');
    // Mock 模式：不连接真实服务，仅测试报告生成流程
    const isMockMode = args.get('is-mock-mode') === 'true';

    if (isMockMode) {
        console.log(
            '[duplicate-check] 🔧 Mock 模式：跳过 MySQL 和 embedding service'
        );
    } else {
        validateEnv();
        const pool = getMySqlPool();
        if (!pool || !env.mysqlEnabled) {
            throw new Error(
                'duplicate-check 需要 MYSQL_ENABLED=true 并可连接 MySQL。'
            );
        }
        if (!env.embeddingServiceUrl) {
            throw new Error(
                'duplicate-check 需要 EMBEDDING_SERVICE_URL（embedding service）。'
            );
        }
    }

    // Type narrowing for TS (pool is guaranteed non-null after guards above)
    const mysqlPool = isMockMode ? null : getMySqlPool();

    const projectRoot = resolve(process.cwd());
    const changed = readLines(changedFilesPath)
        .filter((p) => p.endsWith('.ts') || p.endsWith('.tsx'))
        .filter((p) => !p.includes('/node_modules/') && !p.includes('/dist/'));

    if (changed.length === 0) {
        const empty = {
            ok: true,
            blockingCount: 0,
            warningCount: 0,
            maxSimilarity: 0,
            findings: [] as DuplicateFinding[],
            note: '本次 PR 未包含可索引的 .ts/.tsx 变更文件。',
        };
        writeFileSync(outJson, JSON.stringify(empty, null, 2));
        writeFileSync(
            outMd,
            '## 重复实现检测（CI）\n\n本次 PR 未包含可索引的 `.ts/.tsx` 变更文件。\n'
        );
        return;
    }

    // 1) 仅解析变更文件（通过传绝对路径给 indexProject.globPatterns）
    const absPatterns = changed.map((p) =>
        resolve(projectRoot, p).replace(/\\/g, '/')
    );
    const rows = await indexProject({ projectRoot, globPatterns: absPatterns });

    if (rows.length === 0) {
        const empty = {
            ok: true,
            blockingCount: 0,
            warningCount: 0,
            maxSimilarity: 0,
            findings: [] as DuplicateFinding[],
            note: '变更文件中未抽取到可索引导出代码块。',
        };
        writeFileSync(outJson, JSON.stringify(empty, null, 2));
        writeFileSync(
            outMd,
            '## 重复实现检测（CI）\n\n变更文件中未抽取到可索引导出代码块。\n'
        );
        return;
    }

    // 2) 计算本次变更代码块 embedding（批量）或使用 mock
    let vecs: number[][];
    let client: ReturnType<typeof createEmbeddingClient> | null = null;

    if (isMockMode) {
        // Mock 模式：生成随机向量（维度 1024，与 embedding service 一致）
        vecs = rows.map(() =>
            Array.from({ length: 1024 }, () => Math.random() * 2 - 1)
        );
    } else {
        client = createEmbeddingClient(env.embeddingServiceUrl);
        const texts = rows.map(indexedRowToEmbedText);
        vecs = await embedAll(client, texts);
    }

    // 3) 对每个代码块：拉同 type 候选（有 embedding），算 cosine，取 top1
    type DbCandidate = {
        id: number;
        name: string;
        type: SymbolType;
        path: string;
        meta: Record<string, unknown> | null;
        embedding: number[];
    };

    async function loadCandidates(type: SymbolType): Promise<DbCandidate[]> {
        if (isMockMode) {
            // Mock 模式：返回空候选，模拟"无重复"的检测结果
            return [];
        }
        if (!mysqlPool) return [];

        const [dbRows] = await mysqlPool.query<any[]>(
            `
        SELECT id, name, type, path, CAST(meta AS CHAR) AS meta, embedding
        FROM symbols
        WHERE type = ? AND embedding IS NOT NULL
        ORDER BY usage_count DESC
        LIMIT ?
      `,
            [type, candidateLimit]
        );

        const out: DbCandidate[] = [];
        for (const r of dbRows) {
            let meta: Record<string, unknown> | null = null;
            try {
                meta = r.meta ? JSON.parse(r.meta) : null;
            } catch {
                meta = null;
            }
            let emb: number[] | null = null;
            try {
                const parsed =
                    typeof r.embedding === 'string'
                        ? JSON.parse(r.embedding)
                        : r.embedding;
                if (Array.isArray(parsed)) {
                    const nums = parsed.map((x: any) => Number(x));
                    if (nums.every((n: number) => Number.isFinite(n)))
                        emb = nums;
                }
            } catch {
                emb = null;
            }
            if (!emb) continue;
            out.push({
                id: Number(r.id),
                name: String(r.name),
                type: r.type as SymbolType,
                path: String(r.path),
                meta,
                embedding: emb,
            });
        }
        return out;
    }

    const candidatesByType = new Map<SymbolType, DbCandidate[]>();
    async function getCandidates(type: SymbolType) {
        const cached = candidatesByType.get(type);
        if (cached) return cached;
        const loaded = await loadCandidates(type);
        candidatesByType.set(type, loaded);
        return loaded;
    }

    const findings: DuplicateFinding[] = [];
    let maxSimilarity = 0;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const qv = vecs[i];
        const cand = await getCandidates(row.type);

        let best: { c: DbCandidate; sim: number } | null = null;
        for (const c of cand) {
            if (c.embedding.length !== qv.length) continue;
            const sim = cosineSimilarity(qv, c.embedding);
            if (!best || sim > best.sim) best = { c, sim };
        }
        if (!best) continue;

        const sim = best.sim;
        if (sim > maxSimilarity) maxSimilarity = sim;

        // props 超集判定：仅对 component 生效；其它类型只用语义相似度。
        const newProps = propsForRow(row);
        const oldProps =
            best.c.type === 'component'
                ? uniqueLower(getMetaArray(best.c.meta, 'props'))
                : [];
        const { coverage, isSuperset } =
            row.type === 'component'
                ? coverageAndSuperset(newProps, oldProps)
                : { coverage: 1, isSuperset: true };

        const propsOk =
            row.type !== 'component'
                ? true
                : coverage >= propsCoverageThreshold;

        const level: DuplicateLevel | null =
            sim >= blockThreshold && propsOk && isSuperset
                ? 'blocking'
                : sim >= warnThreshold && propsOk && isSuperset
                  ? 'warning'
                  : null;

        if (!level) continue;

        findings.push({
            level,
            symbol: {
                name: row.name,
                type: row.type,
                path: row.path,
                props: newProps,
            },
            bestMatch: {
                id: best.c.id,
                name: best.c.name,
                type: best.c.type,
                path: best.c.path,
                similarity: toFixed4(sim),
                props: oldProps,
                propsCoverage: toFixed4(coverage),
                propsIsSuperset: isSuperset,
            },
        });
    }

    const blockingCount = findings.filter((f) => f.level === 'blocking').length;
    const warningCount = findings.filter((f) => f.level === 'warning').length;

    // JSON 报告（供 workflow 读 blockingCount/maxSimilarity）
    const report = {
        ok: true,
        mockMode: isMockMode,
        blockingCount,
        warningCount,
        maxSimilarity: toFixed4(maxSimilarity),
        thresholds: {
            blockThreshold,
            warnThreshold,
            propsCoverageThreshold,
            candidateLimit,
        },
        changedFiles: changed,
        extractedSymbols: rows.map((r) => ({
            name: r.name,
            type: r.type,
            path: r.path,
        })),
        findings,
    };
    writeFileSync(outJson, JSON.stringify(report, null, 2));

    // 中文 Markdown（PR 评论）
    const lines: string[] = [];
    lines.push('## 重复实现检测（CI）');
    if (isMockMode) {
        lines.push('');
        lines.push(
            '> ⚠️ **Mock 模式**：本次检测未连接真实 MySQL/embedding service，结果仅供参考。'
        );
    }
    lines.push('');
    lines.push(
        `- 阻断（blocking）阈值：语义相似度 ≥ **${blockThreshold}** 且 **props 超集**`
    );
    lines.push(
        `- 告警（warning）阈值：语义相似度 ≥ **${warnThreshold}** 且 **props 超集**`
    );
    if (propsCoverageThreshold < 1) {
        lines.push(
            `- props 覆盖阈值：覆盖率 ≥ **${propsCoverageThreshold}**（当前要求超集时仍会校验覆盖率）`
        );
    }
    lines.push('');

    if (findings.length === 0) {
        lines.push('未发现需要提示的重复实现候选。');
        lines.push('');
    } else {
        lines.push(
            `本次检测发现：**阻断 ${blockingCount}** 条，**告警 ${warningCount}** 条。`
        );
        lines.push('');
        lines.push(
            '| 级别 | 新增/改动代码块 | 类型 | 最相似存量 | 相似度 | props 超集 | props 覆盖率 |'
        );
        lines.push('|---|---|---|---|---:|---:|---:|');
        for (const f of findings) {
            const newRef = `${escapeMd(f.symbol.name)} \\(${escapeMd(f.symbol.path)}\\)`;
            const oldRef = `${escapeMd(f.bestMatch.name)} \\(${escapeMd(f.bestMatch.path)}\\)`;
            lines.push(
                `| ${f.level === 'blocking' ? '阻断' : '告警'} | ${newRef} | ${f.symbol.type} | ${oldRef} | ${f.bestMatch.similarity} | ${f.bestMatch.propsIsSuperset ? '是' : '否'} | ${f.bestMatch.propsCoverage} |`
            );
        }
        lines.push('');
        lines.push('### 处理建议');
        lines.push(
            '- **优先复用/扩展存量组件**：如果只是新增少量属性，建议把属性合并到存量组件并统一出口。'
        );
        lines.push(
            '- **若确需新建**：请在 PR 描述中说明为什么不能复用（领域差异、历史包袱、兼容性约束等），并由 Owner 审核通过。'
        );
        lines.push('');
    }

    writeFileSync(outMd, lines.join('\n'));

    // Exit code：有 blocking 则非 0（让 workflow fail）
    if (blockingCount > 0) {
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('[duplicate-check] failed:', err);
    process.exit(2);
});
