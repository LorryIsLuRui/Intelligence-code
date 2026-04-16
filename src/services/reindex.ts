import { resolve } from 'node:path';
import { env, loadProjectDotenv } from '../config/env.js';
import { getMySqlPool } from '../db/mysql.js';
import { indexedRowToEmbedText } from '../indexer/embedText.js';
import { indexProject } from '../indexer/indexProject.js';
import { upsertSymbols } from '../indexer/persistSymbols.js';
import {
    initCategoryEmbeddings,
    resolveCategory,
} from '../indexer/categoryClassifier.js';
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
            `MYSQL_HOST=${process.env.MYSQL_HOST}`
    );

    // 3️⃣ 只有需要写入数据库时才检查 MySQL 并建立连接
    const embeddingServiceUrl = process.env.EMBEDDING_SERVICE_URL;
    if (!dryRun && embeddingServiceUrl) {
        // 初始化 category embeddings
        await initCategoryEmbeddings();
    }

    let pool: Awaited<ReturnType<typeof getMySqlPool>> | null = null;
    if (!dryRun) {
        pool = getMySqlPool();
        await pool!.query('SELECT 1'); // 测试连接
        console.error('[reindex] MySQL connection successful');
    }

    let rows = await indexProject({
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
            // 先实现ts语义模板,js保留原逻辑
            const texts = rows.map(
                (row) => row.content ?? indexedRowToEmbedText(row)
            );
            const vecs = await embedAll(client, texts);
            // 生成category
            rows = await resolveCategory(rows, vecs);
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
