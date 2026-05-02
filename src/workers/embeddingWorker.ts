/**
 * BullMQ embedding worker（常驻消费进程）。
 *
 * 流程：
 * 1. 收到 job { semanticHash }
 * 2. 查 semantic_hash 缓存：若已有 status=online 的符号带 embedding → 直接复用（0 次 API 调用）
 * 3. 缓存未命中 → 取一条 pending 行构建语义文本 → 调 embedding API
 * 4. 批量 UPDATE：所有 semantic_hash 相同且 status=pending 的行一次性写入向量并置 online
 *
 * 并发/限流：
 * - concurrency 控制同时处理的 job 数（默认 5）
 * - BullMQ limiter 控制全局 RPM（默认 100/min，留 buffer 低于 OpenAI 3000 RPM）
 *
 * 大仓分片：
 * - 直接启动多个 worker 进程（同一 Redis）即可水平扩展，BullMQ 原生分布式协调
 */
import { Worker, QueueEvents } from 'bullmq';
import type { Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { env } from '../config/env.js';
import { getPool } from '../db/postgres.js';
import { createEmbeddingClient } from '../services/embeddingClient.js';
import { indexedRowToEmbedText } from '../indexer/embedText.js';
import {
    initCategoryEmbeddings,
    resolveCategory,
} from '../indexer/categoryClassifier.js';
import { SYMBOL_STATUS } from '../config/symbolStatus.js';

interface WorkerOptions {
    /** 同时处理的 job 数，默认 5 */
    concurrency?: number;
    /** 每分钟最多调用 embedding API 的次数（跨所有 worker 进程），默认 100 */
    rpmLimit?: number;
}

interface EmbedJob {
    semanticHash: string;
    /** 写入目标表，由 producer 在入队时注入，避免 worker 依赖自身 env */
    symbolsTable?: string;
}

async function processEmbedJob(
    job: Job<EmbedJob>,
    pool: Pool
): Promise<{ updatedRows: number }> {
    const { semanticHash } = job.data;
    // 优先使用 job payload 里的表名（跨项目场景），降级到 env（单项目场景）
    const table = job.data.symbolsTable ?? env.symbolsTable;
    const shortHash = semanticHash.slice(0, 10);
    const embedClient = createEmbeddingClient(env.embeddingServiceUrl);
    const ts = () => new Date().toISOString();

    // Step 1: 缓存命中检查 —— 相同 semantic_hash 已有 online 向量
    const { rows: cached } = await pool.query<any>(
        `SELECT embedding FROM ${table}
         WHERE semantic_hash = $1 AND status = $2 AND embedding IS NOT NULL
         LIMIT 1`,
        [semanticHash, SYMBOL_STATUS.ONLINE]
    );

    let vector: number[];

    if (cached.length > 0) {
        // Cache hit: 直接复用已有向量，0 次 API 调用
        // pgvector 返回字符串 "[x1,x2,...]", JSON.parse 可直接解析
        vector =
            typeof cached[0].embedding === 'string'
                ? JSON.parse(cached[0].embedding)
                : cached[0].embedding;

        // cache hit 时只需把 pending 行的向量补齐（有可能是新增的同语义符号）
        const cacheResult = await pool.query(
            `UPDATE ${table}
             SET embedding = $1::vector, status = $2
             WHERE semantic_hash = $3 AND status = $4`,
            [
                `[${vector.join(',')}]`,
                SYMBOL_STATUS.ONLINE,
                semanticHash,
                SYMBOL_STATUS.PENDING,
            ]
        );
        console.error(
            `[worker] ✅ cache hit   [${ts()}]  table=${table}  hash=${shortHash}…  updated ${cacheResult.rowCount ?? 0} row(s)  (0 API calls)`
        );
        return { updatedRows: cacheResult.rowCount ?? 0 };
    }

    // Cache miss: 取一条 pending 行做 embedding
    const { rows: pending } = await pool.query<any>(
        `SELECT name, type, category, path, description, content, meta
         FROM ${table}
         WHERE semantic_hash = $1 AND status = $2
         LIMIT 1`,
        [semanticHash, SYMBOL_STATUS.PENDING]
    );

    if (pending.length === 0) {
        // 所有行已被并发 worker 处理，幂等退出
        console.error(
            `[worker] ⚠️  skip       [${ts()}]  table=${table}  hash=${shortHash}…  (no pending rows)`
        );
        return { updatedRows: 0 };
    }

    const row = pending[0];
    const meta =
        typeof row.meta === 'string' ? JSON.parse(row.meta) : (row.meta ?? {});
    const rowObj = { ...row, meta };

    console.error(
        `[worker] 🔄 embedding  [${ts()}]  table=${table}  hash=${shortHash}…  ${row.path}:${row.name}`
    );
    const doc = row.content ?? indexedRowToEmbedText(rowObj);
    const vectors = await embedClient.embed([doc]);
    vector = vectors[0];

    // 生成 category（规则 → embedding → LLM 三层融合）
    const [resolvedRow] = await resolveCategory([rowObj], [vector]);
    const resolvedCategory = resolvedRow.category ?? null;

    // Step 2: 批量写入 —— 覆盖所有相同 semantic_hash 的 pending 行
    const result = await pool.query(
        `UPDATE ${table}
         SET embedding = $1::vector, status = $2, category = COALESCE($3, category)
         WHERE semantic_hash = $4 AND status = $5`,
        [
            `[${vector.join(',')}]`,
            SYMBOL_STATUS.ONLINE,
            resolvedCategory,
            semanticHash,
            SYMBOL_STATUS.PENDING,
        ]
    );
    console.error(
        `[worker] ✓  done        [${ts()}]  table=${table}  hash=${shortHash}…  category=${resolvedCategory ?? 'null'}  updated ${result.rowCount ?? 0} row(s)`
    );
    return { updatedRows: result.rowCount ?? 0 };
}

/**
 * 启动 embedding worker，返回包含 stop() 的句柄。
 */
export async function startEmbeddingWorker(
    opts: WorkerOptions = {}
): Promise<{ worker: Worker; stop: () => Promise<void> }> {
    const { concurrency = 5, rpmLimit = 100 } = opts;

    const connection = new Redis(env.redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
    });

    // 独立连接监听队列事件（BullMQ 要求不共用 Worker 连接）
    const eventsConnection = new Redis(env.redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
    });
    const queueEvents = new QueueEvents('embedding', {
        connection: eventsConnection,
    });

    const pool = getPool();

    // 预热 category embeddings（仅在服务启动时调用一次）
    if (env.embeddingServiceUrl) {
        await initCategoryEmbeddings();
        console.error('[embedding-worker] category embeddings initialized');
    }

    const worker = new Worker<EmbedJob, { updatedRows: number }>(
        'embedding',
        (job: Job<EmbedJob>) => processEmbedJob(job, pool),
        {
            connection,
            concurrency,
            // 全局限流：所有 worker 进程共享，防止触发 OpenAI rate limit
            limiter: { max: rpmLimit, duration: 60_000 },
            // 完成后立即从 Redis 清除，避免 jobId 残留导致下次同 hash 无法入队
            removeOnComplete: { count: 0 },
            removeOnFail: { count: 100 },
        }
    );

    // 累计统计：每次 drained 后重置
    const stats = { completed: 0, updatedRows: 0 };

    worker.on(
        'completed',
        (_job: Job<EmbedJob>, result: { updatedRows: number }) => {
            stats.completed++;
            stats.updatedRows += result?.updatedRows ?? 0;
        }
    );

    worker.on('failed', (job: Job<EmbedJob> | undefined, err: Error) => {
        console.error(
            `[worker] ✗  failed     [${new Date().toISOString()}]  table=${job?.data?.symbolsTable ?? env.symbolsTable}  hash=${job?.data?.semanticHash?.slice(0, 10)}…  err=${err.message}`
        );
    });

    worker.on('error', (err: Error) => {
        console.error(`[worker] error: ${err.message}`);
    });

    // 队列清空时打汇总（全量 reindex 入队后监听，确认所有 embedding 已处理）
    queueEvents.on('drained', () => {
        console.error(
            `[worker] ✅ queue drained  [${new Date().toISOString()}]  completed=${stats.completed} jobs  rows_updated=${stats.updatedRows}`
        );
        stats.completed = 0;
        stats.updatedRows = 0;
    });

    const stop = async () => {
        await worker.close();
        await queueEvents.close();
    };

    return { worker, stop };
}
