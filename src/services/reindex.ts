import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import fg from 'fast-glob';
import { env } from '../config/env.js';
import { getPool } from '../db/postgres.js';
import { getAllTableSQLs } from '../db/schema.js';
import { indexProject, DEFAULT_IGNORE } from '../indexer/indexProject.js';
import { upsertSymbols } from '../indexer/persistSymbols.js';
import { computeFileHash } from '../indexer/tsAstNormalizer.js';
import { getRelativePathForDisplay } from '../indexer/heuristics.js';
import {
    enqueueEmbeddingBatch,
    closeEmbeddingQueue,
} from '../services/embeddingQueue.js';
import { SYMBOL_STATUS } from '../config/symbolStatus.js';

export interface ReindexOptions {
    projectRoot?: string;
    globPatterns?: string[];
    ignore?: string[];
    dryRun?: boolean;
    /**
     * 强制全量重建模式。
     * 用于：embedding 模型升级、语义模板逻辑变更、清理漂移/僵尸数据。
     * 效果：跳过 file_hash 过滤（全量解析），清空已有 embedding，全部重新入队。
     * 注意：此时不应复用任何缓存，file_hash 同样无效。
     */
    forceRebuild?: boolean;
}

export interface ReindexResult {
    projectRoot: string;
    extractedCount: number;
    /** file_hash 未变，跳过 AST 解析的文件数 */
    skippedFiles: number;
    /** 入队给 worker 处理 embedding 的 semantic_hash 数（去重后） */
    enqueuedCount: number;
    upserted: boolean;
}

function isCallerDebugEnabled(): boolean {
    return /^(1|true|yes|on)$/i.test(process.env.DEBUG_CALLERS ?? '');
}

function getCallerDebugMatch(): string {
    return (process.env.DEBUG_CALLERS_MATCH ?? '').trim().toLowerCase();
}

function debugMatchedFiles(
    stage: string,
    files: string[],
    projectRoot: string
): void {
    if (!isCallerDebugEnabled()) return;
    const match = getCallerDebugMatch();
    const normalized = files.map((file) =>
        getRelativePathForDisplay(projectRoot, file)
    );
    const matched = match
        ? normalized.filter((file) => file.toLowerCase().includes(match))
        : normalized;

    console.error(
        `[callers.debug] ${stage} ${JSON.stringify({
            match: match || null,
            count: matched.length,
            files: matched,
        })}`
    );
}

export async function runReindex(
    options: ReindexOptions = {}
): Promise<ReindexResult> {
    const projectRoot = resolve(options.projectRoot ?? process.cwd());
    const { dryRun = false, forceRebuild = false } = options;

    console.error(
        `[reindex] projectRoot=${projectRoot}, dryRun=${dryRun}, forceRebuild=${forceRebuild}, PG_URL=${process.env.PG_URL ? '(set)' : '(not set)'}, SYMBOLS_TABLE=${env.symbolsTable}`
    );

    let pool: ReturnType<typeof getPool> | null = null;
    if (!dryRun) {
        pool = getPool();
        await pool.query('SELECT 1');
        console.error('[reindex] PostgreSQL connection successful');

        // 确保 extension + table + indexes 存在（幂等，多租户表名安全）
        for (const sql of getAllTableSQLs()) {
            await pool.query(sql);
        }
        console.error(`[reindex] schema ready: ${env.symbolsTable}`);
    }

    // ─── 1. glob 解析出全量文件列表（绝对路径）──────────────────────────
    const ignore = [...DEFAULT_IGNORE, ...(options.ignore ?? [])];
    const patterns = (options.globPatterns ?? ['src/**/*.{ts,tsx}']).map((p) =>
        p.startsWith('/') ? p : join(projectRoot, p).replace(/\\/g, '/')
    );
    const allFiles = await fg(patterns, {
        absolute: true,
        ignore,
        onlyFiles: true,
        dot: false,
    });
    console.error(`[reindex] glob found ${allFiles.length} file(s)`);
    debugMatchedFiles('reindex-all-files', allFiles, projectRoot);

    // ─── 2. file_hash 过滤：跳过 AST 未变的文件（CPU 优化）────────────────
    // forceRebuild 时跳过此过滤，file_hash 不可复用（模板/模型变更时相同文件产出不同 content）
    let filesToIndex = allFiles;
    let skippedFiles = 0;

    if (!forceRebuild && pool && allFiles.length > 0) {
        // 计算所有文件当前 hash
        const currentFileHashes = new Map<string, string>(); // relPath → hash
        for (const absPath of allFiles) {
            const content = readFileSync(absPath, 'utf-8');
            const relPath = getRelativePathForDisplay(projectRoot, absPath);
            currentFileHashes.set(relPath, computeFileHash(content));
        }

        // 一次性批量查 DB 已有的 file_hash
        const relPaths = [...currentFileHashes.keys()];
        const { rows: dbRows } = await pool!.query<{
            path: string;
            file_hash: string;
        }>(
            `SELECT DISTINCT path, file_hash FROM ${env.symbolsTable}
             WHERE path = ANY($1) AND file_hash IS NOT NULL`,
            [relPaths]
        );
        const dbFileHash = new Map<string, string>(
            dbRows.map((r) => [r.path, r.file_hash])
        );

        filesToIndex = allFiles.filter((absPath) => {
            const relPath = getRelativePathForDisplay(projectRoot, absPath);
            return currentFileHashes.get(relPath) !== dbFileHash.get(relPath);
        });
        skippedFiles = allFiles.length - filesToIndex.length;
        console.error(
            `[reindex] file_hash: ${skippedFiles} unchanged (skipped), ${filesToIndex.length} changed (to parse)`
        );
        const skippedAbsFiles = allFiles.filter(
            (absPath) => !filesToIndex.includes(absPath)
        );
        debugMatchedFiles('reindex-files-to-parse', filesToIndex, projectRoot);
        debugMatchedFiles(
            'reindex-files-skipped',
            skippedAbsFiles,
            projectRoot
        );
    } else if (forceRebuild) {
        console.error(
            `[reindex] forceRebuild=true, skipping file_hash filter — parsing all ${allFiles.length} file(s)`
        );
        debugMatchedFiles('reindex-files-to-parse', filesToIndex, projectRoot);
    }

    if (filesToIndex.length === 0) {
        console.error('[reindex] all files unchanged, nothing to do');
        return {
            projectRoot,
            extractedCount: 0,
            skippedFiles,
            enqueuedCount: 0,
            upserted: false,
        };
    }

    // ─── 3. 只对变更文件做 AST 解析 ──────────────────────────────────
    const rows = await indexProject({
        projectRoot,
        globPatterns: filesToIndex,
    });
    console.error(
        `[reindex] extracted ${rows.length} symbol(s) from ${filesToIndex.length} changed file(s)`
    );

    // ─── 4. 写库（全部 pending）→ 入队，worker 异步处理 embedding + category ──
    const nullPayload = rows.map(() => null as number[] | null);
    const pendingHashes = [
        ...new Set(
            rows.map((r) => r.semantic_hash).filter(Boolean) as string[]
        ),
    ];

    if (!dryRun) {
        // forceRebuild：先清空 DB 中已有的 embedding，使 worker cache check 必然 miss
        if (forceRebuild && pendingHashes.length > 0) {
            await pool!.query(
                `UPDATE ${env.symbolsTable}
                 SET embedding = NULL, status = $1
                 WHERE semantic_hash = ANY($2)`,
                [SYMBOL_STATUS.PENDING, pendingHashes]
            );
            console.error(
                `[reindex] forceRebuild: cleared embeddings for ${pendingHashes.length} semantic_hash(es)`
            );
        }

        await upsertSymbols(pool!, rows, nullPayload);

        if (pendingHashes.length > 0) {
            await enqueueEmbeddingBatch(pendingHashes, env.symbolsTable);
            console.error(
                `[reindex] enqueued ${pendingHashes.length} semantic_hash(es) → worker will handle embedding asynchronously`
            );
        }
        await closeEmbeddingQueue();
    }

    return {
        projectRoot,
        extractedCount: rows.length,
        skippedFiles,
        enqueuedCount: pendingHashes.length,
        upserted: !dryRun,
    };
}
