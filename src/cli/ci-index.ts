// CI增量索引：处理changed files和deleted files
import { env } from '../config/env.js';
import { getPool } from '../db/postgres.js';
import { indexProject } from '../indexer/indexProject.js';
import { upsertSymbols } from '../indexer/persistSymbols.js';
import { SYMBOL_STATUS } from '../config/symbolStatus.js';
import {
    enqueueEmbeddingBatch,
    closeEmbeddingQueue,
} from '../services/embeddingQueue.js';
import { reconcileIndexedSymbols } from '../services/reconcileIndexedSymbols.js';

export interface IncrementalIndexOptions {
    projectRoot: string;
    changedFiles: string[];
    deletedFiles: string[];
    renamedFiles?: { from: string; to: string }[];
}

export async function runIncrementalIndex(opts: IncrementalIndexOptions) {
    const { projectRoot, changedFiles, deletedFiles, renamedFiles = [] } = opts;

    const pool = getPool();
    const tableName = env.symbolsTable;
    const rows =
        changedFiles.length > 0
            ? await indexProject({
                  projectRoot,
                  globPatterns: changedFiles,
              })
            : [];
    const nullPayload = rows.map(() => null as number[] | null);
    const hashes = [
        ...new Set(rows.map((r) => r.semantic_hash).filter(Boolean)),
    ] as string[];

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. 删除文件：标记 offline
        for (const file of deletedFiles) {
            await client.query(
                `UPDATE ${tableName} SET status = $1::smallint WHERE path = $2`,
                [SYMBOL_STATUS.OFFLINE, file]
            );
            console.error(`[ci-index] marked offline: ${file}`);
        }

        // 2. 重命名文件：更新path
        for (const { from, to } of renamedFiles) {
            await client.query(
                `UPDATE ${tableName} SET path = $1 WHERE path = $2`,
                [to, from]
            );
            console.error(`[ci-index] renamed: ${from} -> ${to}`);
        }

        // 3. 变更/新增文件：重新索引并标记 pending
        if (rows.length > 0) {
            await upsertSymbols(client, rows, nullPayload);

            for (const row of rows) {
                console.error(`[ci-index] upserted: ${row.path}:${row.name}`);
            }

            await reconcileIndexedSymbols(client, changedFiles, rows);
        }

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }

    try {
        if (hashes.length > 0) {
            await enqueueEmbeddingBatch(hashes, env.symbolsTable);
            console.error(
                `[ci-index] enqueued ${hashes.length} unique semantic hashes for embedding`
            );
        }
        await closeEmbeddingQueue();
    } finally {
        await pool.end();
    }

    console.error(
        `[ci-index] processed ${deletedFiles.length} deletions, ${renamedFiles.length} renames, ${changedFiles.length} changes`
    );
}
