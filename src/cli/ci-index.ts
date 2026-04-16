// CI增量索引：处理changed files和deleted files
import { env, loadProjectDotenv } from '../config/env.js';
import { getMySqlPool } from '../db/mysql.js';
import { indexProject } from '../indexer/indexProject.js';
import {
    DEFAULT_STATUS_ON_UPSERT,
    SYMBOL_STATUS,
} from '../config/symbolStatus.js';
import {
    enqueueEmbeddingBatch,
    closeEmbeddingQueue,
} from '../services/embeddingQueue.js';

export interface IncrementalIndexOptions {
    projectRoot: string;
    changedFiles: string[];
    deletedFiles: string[];
    renamedFiles?: { from: string; to: string }[];
}

export async function runIncrementalIndex(opts: IncrementalIndexOptions) {
    const { projectRoot, changedFiles, deletedFiles, renamedFiles = [] } = opts;

    loadProjectDotenv(projectRoot);
    const pool = getMySqlPool();
    if (!pool) {
        throw new Error('Failed to get MySQL pool');
    }
    const tableName = env.mysqlSymbolsTable;

    // 1. 删除文件：标记 offline
    for (const file of deletedFiles) {
        await pool.query(`UPDATE ${tableName} SET status = ? WHERE path = ?`, [
            SYMBOL_STATUS.OFFLINE,
            file,
        ]);
        console.error(`[ci-index] marked offline: ${file}`);
    }

    // 2. 重命名文件：更新path
    for (const { from, to } of renamedFiles) {
        await pool.query(`UPDATE ${tableName} SET path = ? WHERE path = ?`, [
            to,
            from,
        ]);
        console.error(`[ci-index] renamed: ${from} -> ${to}`);
    }

    // 3. 变更/新增文件：重新索引并标记 pending
    if (changedFiles.length > 0) {
        const rows = await indexProject({
            projectRoot,
            globPatterns: changedFiles,
        });

        for (const row of rows) {
            // 写入结构化数据
            // status 逻辑：新行写 pending；已有行仅在 semantic_hash 发生变化时才重置为 pending，
            // hash 未变说明语义未变，保留原 status（online → 缓存命中，不重复 embedding）
            await pool.query(
                `INSERT INTO ${tableName}
                   (name, type, category, path, description, content, meta,
                    file_hash, semantic_hash, status,
                    usage_count, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, 0, NOW(), NOW())
                 ON DUPLICATE KEY UPDATE
                   type             = VALUES(type),
                   category         = VALUES(category),
                   description      = VALUES(description),
                   content          = VALUES(content),
                   meta             = VALUES(meta),
                   file_hash        = VALUES(file_hash),
                   semantic_hash    = VALUES(semantic_hash),
                   status           = IF(semantic_hash = VALUES(semantic_hash), status, VALUES(status)),
                   updated_at       = NOW()`,
                [
                    row.name,
                    row.type,
                    row.category ?? null,
                    row.path,
                    row.description ?? null,
                    row.content ?? null,
                    JSON.stringify(row.meta),
                    row.file_hash,
                    row.semantic_hash,
                    DEFAULT_STATUS_ON_UPSERT,
                ]
            );

            console.error(`[ci-index] upserted: ${row.path}:${row.name}`);
        }

        // 批量入队：jobId = semanticHash，相同 hash 自动去重，1000 个符号可能只产生 N 个唯一 job
        const hashes = [
            ...new Set(rows.map((r) => r.semantic_hash).filter(Boolean)),
        ] as string[];
        if (hashes.length > 0) {
            await enqueueEmbeddingBatch(hashes);
            console.error(
                `[ci-index] enqueued ${hashes.length} unique semantic hashes for embedding`
            );
        }
    }

    await closeEmbeddingQueue();
    await pool.end();
    console.error(
        `[ci-index] processed ${deletedFiles.length} deletions, ${renamedFiles.length} renames, ${changedFiles.length} changes`
    );
}
