#!/usr/bin/env node
/**
 * Phase 2 CLI：扫描代码库并写入 PostgreSQL `symbols`。
 *
 * 环境变量加载顺序：
 * 1. 命令行参数（最高优先级）
 * 2. INDEX_ROOT 指向的第三方项目 .env（中等优先级，优先使用第三方显式设置的值）
 * 3. 本地的 .env（最低优先级，提供默认值）
 */
import { resolve } from 'node:path';
import { CLI_KEYS, loadProjectDotenv } from '../config/env.js';
import { runReindex } from '../services/reindex.js';

/**
 * 入口：加载第三方 .env → 校验环境 → 调用 runReindex。
 * 进度与统计输出到 **stderr**，避免占用 stdout。
 * 进程退出码：成功 `0`，连接失败或异常 `1`。
 */
async function main() {
    // Step 1: 始终从 cwd 加载第三方 .env（这是 P2，会覆盖本地 MCP .env）
    // 注意：不能用 process.env.INDEX_ROOT，那个值可能已被本地 MCP .env（P3）污染
    const thirdPartyKeys = loadProjectDotenv(process.cwd());

    // Step 2: INDEX_ROOT 只有来自 P1（CLI）或 P2（第三方 .env）时才可信
    // 若只在本地 MCP .env（P3）里设了 INDEX_ROOT，在第三方项目中运行时应忽略它
    const indexRoot =
        CLI_KEYS.has('INDEX_ROOT') || thirdPartyKeys.has('INDEX_ROOT')
            ? process.env.INDEX_ROOT
            : undefined;
    const projectRoot = resolve(indexRoot ?? process.cwd());
    console.error(
        `PG_URL=${process.env.PG_URL ? '(set)' : '(not set)'}` +
            `[index] projectRoot=${projectRoot} (INDEX_ROOT: ${CLI_KEYS.has('INDEX_ROOT') ? 'CLI' : thirdPartyKeys.has('INDEX_ROOT') ? 'third-party .env' : 'cwd fallback'})`
    );

    const globPatterns = process.env.INDEX_GLOB
        ? process.env.INDEX_GLOB.split(/\s+/)
              .map((s) => s.trim())
              .filter(Boolean)
        : undefined;
    const ignore = process.env.INDEX_IGNORE
        ? process.env.INDEX_IGNORE.split(',').map((s) => s.trim())
        : undefined;

    const forceRebuild = process.argv.includes('--force-rebuild');

    const result = await runReindex({
        projectRoot,
        globPatterns,
        ignore,
        dryRun: false,
        forceRebuild,
    });
    console.error(
        `[index] extracted ${result.extractedCount} symbol(s), enqueued ${result.enqueuedCount} for embedding`
    );
    console.error(
        '[index] upserted into PostgreSQL, success:',
        result.upserted
    );
}

main().catch((err: unknown) => {
    console.error('[index] failed:', err);
    const anyErr = err as { code?: string; errno?: number };
    if (anyErr.code === 'ECONNREFUSED') {
        const pgUrl =
            process.env.PG_URL ?? 'postgresql://...@127.0.0.1:5432/...';
        console.error(
            `[index] 原因: 无法连接 PostgreSQL（连接被拒绝）。当前 PG_URL=${pgUrl}。请确认 docker compose up -d 已启动 pgvector 容器。`
        );
    } else if (
        anyErr.code === 'ER_ACCESS_DENIED_ERROR' ||
        anyErr.code === '28P01'
    ) {
        console.error(
            '[index] 原因: 用户名或密码错误，请检查 PG_URL 中的 user/password。'
        );
    } else if (anyErr.code === 'ENOTFOUND' || anyErr.code === 'ETIMEDOUT') {
        console.error(
            '[index] 原因: 网络不可达或超时，请检查 PG_URL 中的 host 是否可解析。'
        );
    }
    process.exit(1);
});
