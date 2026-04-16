/**
 * BullMQ embedding 队列 producer。
 *
 * 去重策略：
 * - 同一 CI run 内：ci-index.ts 用 new Set(hashes) 去重后再入队，Redis 层无需 jobId 去重
 * - 跨 CI run 的向量缓存：由 worker 查询 DB（status=online AND semantic_hash=?）决定是否调 API
 * - 不使用 jobId，避免 BullMQ completed 状态残留导致后续 run 任务被跳过
 *
 * CI 流程只负责 enqueue，worker 异步消费，CI 不阻塞。
 * 调用方在进程退出前需调用 closeEmbeddingQueue() 释放连接。
 */
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';

let _queue: Queue | null = null;
let _connection: Redis | null = null;

function getQueue(): Queue {
    if (!_queue) {
        _connection = new Redis(env.redisUrl, {
            maxRetriesPerRequest: null, // BullMQ required
            enableReadyCheck: false,
        });
        _queue = new Queue('embedding', { connection: _connection });
    }
    return _queue;
}

/** 单个 semanticHash 入队 */
export async function enqueueEmbedding(semanticHash: string): Promise<void> {
    await getQueue().add(
        'embed',
        { semanticHash },
        {
            attempts: 5,
            backoff: { type: 'exponential', delay: 5_000 },
        }
    );
}

/**
 * 批量入队（同一 CI run 内已由调用方 new Set 去重）。
 * worker 消费时查 DB 决定是否真正调 embedding API。
 */
export async function enqueueEmbeddingBatch(
    semanticHashes: string[]
): Promise<void> {
    const queue = getQueue();
    const jobs = semanticHashes.map((hash) => ({
        name: 'embed',
        data: { semanticHash: hash },
        opts: {
            attempts: 5,
            backoff: { type: 'exponential' as const, delay: 5_000 },
        },
    }));
    await queue.addBulk(jobs);
}

/** 进程退出前关闭连接（CI 脚本必须调用，否则进程挂起） */
export async function closeEmbeddingQueue(): Promise<void> {
    await _queue?.close();
    await _connection?.quit();
    _queue = null;
    _connection = null;
}
