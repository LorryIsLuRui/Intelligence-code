import { resolve } from 'node:path';
import { env, loadProjectDotenv } from '../config/env.js';
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
    const projectRoot = resolve(options.projectRoot ?? process.cwd());
    const { dryRun = false } = options;

    // 1️ 加载第三方 .env：只覆盖未定义的变量 → 保留 MCP Server 自身配置
    loadProjectDotenv(projectRoot);

    // 2️ 打印生效的环境变量（便于调试）
    console.error(
        `[reindex] projectRoot=${projectRoot}, dryRun=${dryRun}, ` +
            `MYSQL_ENABLED=${process.env.MYSQL_ENABLED}, ` +
            `MYSQL_HOST=${process.env.MYSQL_HOST}`
    );

    // 3️⃣ 只有需要写入数据库时才检查 MySQL 并建立连接
    // 注意：直接检查 process.env，因为 env.mysqlEnabled 是模块加载时计算的，不会反映 loadProjectDotenv 的更新
    const mysqlEnabled = process.env.MYSQL_ENABLED === 'true';
    const embeddingServiceUrl = process.env.EMBEDDING_SERVICE_URL;
    let pool: Awaited<ReturnType<typeof getMySqlPool>> | null = null;
    if (!dryRun) {
        if (!mysqlEnabled) {
            throw new Error(
                `最新！${JSON.stringify(process.env)}执行 reindex 写入数据库需要 MYSQL_ENABLED=true。' +
                    '第三方项目可在 .env 中配置此变量（未配置则使用 MCP Server 本地配置）。`
            );
        }
        pool = getMySqlPool();
        await pool!.query('SELECT 1'); // 测试连接
        console.error('[reindex] MySQL connection successful');
    }

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

    if (!options.dryRun && rows.length > 0 && embeddingServiceUrl) {
        try {
            const client = createEmbeddingClient(embeddingServiceUrl);
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
        await upsertSymbols(pool!, rows, embeddingPayload);
    }

    return {
        projectRoot,
        extractedCount: rows.length,
        upserted: !options.dryRun,
        embeddingsComputed,
    };
}
