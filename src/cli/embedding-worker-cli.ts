/**
 * embedding worker 进程入口。
 *
 * 本地启动：
 *   npm run worker:embedding
 *
 * 大仓分片（多进程并行）：
 *   WORKER_CONCURRENCY=10 npm run worker:embedding &
 *   WORKER_CONCURRENCY=10 npm run worker:embedding &
 *   # 启动 N 个进程，BullMQ 自动分配任务，无需手动分片
 *
 * 环境变量：
 *   REDIS_URL           Redis 连接 URL（默认 redis://127.0.0.1:6379）
 *   MYSQL_HOST / ...    MySQL 连接配置
 *   EMBEDDING_SERVICE_URL  Python embedding 服务地址
 *   WORKER_CONCURRENCY  单进程并发 job 数（默认 5）
 *   WORKER_RPM_LIMIT    全局 RPM 上限（默认 100，跨所有 worker 进程）
 *   PROJECT_ROOT        项目根目录，用于加载 .env（默认 cwd）
 */
import { loadProjectDotenv } from '../config/env.js';
import { startEmbeddingWorker } from '../workers/embeddingWorker.js';

const projectRoot = process.env.PROJECT_ROOT ?? process.cwd();
loadProjectDotenv(projectRoot);

const concurrency = Number(process.env.WORKER_CONCURRENCY ?? '5');
const rpmLimit = Number(process.env.WORKER_RPM_LIMIT ?? '100');

const { worker, stop } = await startEmbeddingWorker({ concurrency, rpmLimit });

console.error(
    `[embedding-worker] started  concurrency=${concurrency}  rpm_limit=${rpmLimit}`
);

// 当前 job 执行完再退出
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
        console.error('[embedding-worker] shutting down…');
        await stop();
        process.exit(0);
    });
}
