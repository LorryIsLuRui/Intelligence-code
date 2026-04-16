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
import type { Pool } from 'mysql2/promise';
import { env } from '../config/env.js';
import { getMySqlPool } from '../db/mysql.js';
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
}

async function processEmbedJob(job: Job<EmbedJob>, pool: Pool): Promise<void> {
    const { semanticHash } = job.data;
    const shortHash = semanticHash.slice(0, 10);
    const table = env.mysqlSymbolsTable;
    const embedClient = createEmbeddingClient(env.embeddingServiceUrl);

    // Step 1: 缓存命中检查 —— 相同 semantic_hash 已有 online 向量
    const [cached] = await pool.query<any[]>(
        `SELECT embedding FROM ${table}
         WHERE semantic_hash = ? AND status = ? AND embedding IS NOT NULL
         LIMIT 1`,
        [semanticHash, SYMBOL_STATUS.ONLINE]
    );

    let vector: number[];

    if (cached.length > 0) {
        // Cache hit: 直接复用已有向量，0 次 API 调用
        vector =
            typeof cached[0].embedding === 'string'
                ? JSON.parse(cached[0].embedding)
                : cached[0].embedding;
        console.error(
            `[worker] ✅ cache hit   hash=${shortHash}…  (0 API calls)`
        );

        // cache hit 时只需把 pending 行的向量补齐（有可能是新增的同语义符号）
        await pool.query(
            `UPDATE ${table}
             SET embedding = CAST(? AS JSON), status = ?
             WHERE semantic_hash = ? AND status = ?`,
            [
                JSON.stringify(vector),
                SYMBOL_STATUS.ONLINE,
                semanticHash,
                SYMBOL_STATUS.PENDING,
            ]
        );
        return;
    }

    // Cache miss: 取一条 pending 行做 embedding
    const [pending] = await pool.query<any[]>(
        `SELECT name, type, category, path, description, content, meta
         FROM ${table}
         WHERE semantic_hash = ? AND status = ?
         LIMIT 1`,
        [semanticHash, SYMBOL_STATUS.PENDING]
    );

    if (pending.length === 0) {
        // 所有行已被并发 worker 处理，幂等退出
        console.error(
            `[worker] ⚠️  skip       hash=${shortHash}…  (no pending rows)`
        );
        return;
    }

    const row = pending[0];
    const meta =
        typeof row.meta === 'string' ? JSON.parse(row.meta) : (row.meta ?? {});
    const rowObj = { ...row, meta };

    console.error(
        `[worker] 🔄 embedding  hash=${shortHash}…  ${row.path}:${row.name}`
    );
    // 与 reindex 保持一致：优先用 content（语义模板），降级用 indexedRowToEmbedText
    const doc = row.content ?? indexedRowToEmbedText(rowObj);
    const vectors = await embedClient.embed([doc]);
    vector = vectors[0];

    // 生成 category（规则 → embedding → LLM 三层融合）
    const [resolvedRow] = await resolveCategory([rowObj], [vector]);
    const resolvedCategory = resolvedRow.category ?? null;

    // Step 2: 批量写入 —— 覆盖所有相同 semantic_hash 的 pending 行
    const [result] = await pool.query<any>(
        `UPDATE ${table}
         SET embedding = CAST(? AS JSON), status = ?, category = COALESCE(?, category)
         WHERE semantic_hash = ? AND status = ?`,
        [
            JSON.stringify(vector),
            SYMBOL_STATUS.ONLINE,
            resolvedCategory,
            semanticHash,
            SYMBOL_STATUS.PENDING,
        ]
    );
    console.error(
        `[worker] ✓  done        hash=${shortHash}…  category=${resolvedCategory ?? 'null'}  updated ${result.affectedRows} row(s)`
    );
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

    const pool = getMySqlPool();
    if (!pool) {
        throw new Error(
            '[embeddingWorker] MySQL pool unavailable — check env vars'
        );
    }

    // 预热 category embeddings（仅在服务启动时调用一次）
    if (env.embeddingServiceUrl) {
        await initCategoryEmbeddings();
        console.error('[embedding-worker] category embeddings initialized');
    }

    const worker = new Worker<EmbedJob>(
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

    worker.on('failed', (job: Job<EmbedJob> | undefined, err: Error) => {
        console.error(
            `[worker] ✗  failed     hash=${job?.data?.semanticHash?.slice(0, 10)}…  err=${err.message}`
        );
    });

    worker.on('error', (err: Error) => {
        console.error(`[worker] error: ${err.message}`);
    });

    // 队列清空时打完成信号（全量 reindex 入队后监听，确认所有 embedding 已处理）
    queueEvents.on('drained', () => {
        console.error(
            '[worker] ✅ all embedding jobs processed — queue is now empty'
        );
    });

    const stop = async () => {
        await worker.close();
        await queueEvents.close();
    };

    return { worker, stop };
}
