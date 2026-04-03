import { resolve } from 'node:path';
import { env, validateEnv } from '../config/env.js';
import { getMySqlPool } from '../db/mysql.js';
import { indexedRowToEmbedText } from '../indexer/embedText.js';
import { indexProject } from '../indexer/indexProject.js';
import { upsertSymbols } from '../indexer/persistSymbols.js';
import {
    createEmbeddingClient,
    embedAll,
} from '../services/embeddingClient.js';

export interface ReindexOptions {
    projectRoot?: string;
    globPatterns?: string[];
    ignore?: string[];
    dryRun?: boolean;
}

export interface ReindexResult {
    projectRoot: string;
    extractedCount: number;
    upserted: boolean;
    /** Phase 5：是否尝试写入了向量（需 EMBEDDING_SERVICE_URL + 列存在） */
    embeddingsComputed: boolean;
}

export async function runReindex(
    options: ReindexOptions = {}
): Promise<ReindexResult> {
    validateEnv();
    const pool = getMySqlPool();
    console.error('[reindex] pool', 'options:', JSON.stringify(options));
    if (!pool || !env.mysqlEnabled) {
        console.error('[reindex] pool', pool, env.mysqlEnabled);
        throw new Error('执行 reindex 前必须开启 MYSQL_ENABLED=true。');
    }

    await pool.query('SELECT 1'); // 测试连接，提前捕获常见的连接错误（如拒绝、认证失败、超时等），并给出更友好的提示。
    console.error('[reindex] MySQL connection successful');
    const projectRoot = resolve(options.projectRoot ?? process.cwd());
    const rows = await indexProject({
        projectRoot,
        globPatterns: options.globPatterns,
        ignore: options.ignore,
    });
    console.error(
        `[reindex] extracted ${rows.length} symbol(s) from ${projectRoot}`
    );

    let embeddingsComputed = false;
    let embeddingPayload: (number[] | null)[] | undefined;

    if (!options.dryRun && rows.length > 0 && env.embeddingServiceUrl) {
        try {
            const client = createEmbeddingClient(env.embeddingServiceUrl);
            const texts = rows.map(indexedRowToEmbedText);
            const vecs = await embedAll(client, texts);
            embeddingPayload = vecs;
            embeddingsComputed = true;
        } catch (err) {
            console.error('[reindex] embedding skipped (service error):', err);
            embeddingPayload = rows.map(() => null);
        }
    }

    if (!options.dryRun) {
        await upsertSymbols(pool, rows, embeddingPayload);
    }

    return {
        projectRoot,
        extractedCount: rows.length,
        upserted: !options.dryRun,
        embeddingsComputed,
    };
}
