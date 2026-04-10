#!/usr/bin/env node
/**
 * Phase 2 CLI：扫描代码库并写入 MySQL `symbols`。
 *
 * 环境变量加载顺序：
 * 1. 命令行参数（最高优先级）
 * 2. INDEX_ROOT 指向的第三方项目 .env（中等优先级，优先使用第三方显式设置的值）
 * 3. 本地的 .env（最低优先级，提供默认值）
 */
import { resolve } from 'node:path';
import { loadProjectDotenv } from '../config/env.js';
import { runReindex } from '../services/reindex.js';

/**
 * 入口：加载第三方 .env → 校验环境 → 调用 runReindex。
 * 进度与统计输出到 **stderr**，避免占用 stdout。
 * 进程退出码：成功 `0`，无 MySQL 或异常 `1`。
 */
async function main() {
    const projectRoot = resolve(process.env.INDEX_ROOT ?? process.cwd());
    loadProjectDotenv(projectRoot);
    console.error(
        `MYSQL_HOST=${process.env.MYSQL_HOST}` +
            `[index] projectRoot=${projectRoot}`
    );

    const globPatterns = process.env.INDEX_GLOB
        ? process.env.INDEX_GLOB.split(/\s+/)
              .map((s) => s.trim())
              .filter(Boolean)
        : undefined;
    const ignore = process.env.INDEX_IGNORE
        ? process.env.INDEX_IGNORE.split(',').map((s) => s.trim())
        : undefined;

    const result = await runReindex({
        projectRoot,
        globPatterns,
        ignore,
        dryRun: false,
    });
    console.error(`[index] extracted ${result.extractedCount} symbol(s)`);
    console.error(`[index] embeddings computed: ${result.embeddingsComputed}`);
    console.error('[index] upserted into MySQL, success:', result.upserted);
}

main().catch((err: unknown) => {
    console.error('[index] failed:', err);
    const anyErr = err as { code?: string; errno?: number };
    if (anyErr.code === 'ECONNREFUSED') {
        const host = process.env.MYSQL_HOST ?? '127.0.0.1';
        const port = process.env.MYSQL_PORT ?? '3306';
        console.error(
            `[index] 原因: 无法连接 ${host}:${port}（连接被拒绝）。请先在本机启动 MySQL/MariaDB，或把 .env 里的 MYSQL_HOST / MYSQL_PORT 改成实际地址。macOS 可用 brew services start mysql 等方式启动。`
        );
    } else if (anyErr.code === 'ER_ACCESS_DENIED_ERROR') {
        console.error(
            '[index] 原因: 用户名或密码错误，请检查 MYSQL_USER / MYSQL_PASSWORD。'
        );
    } else if (anyErr.code === 'ENOTFOUND' || anyErr.code === 'ETIMEDOUT') {
        console.error(
            '[index] 原因: 网络不可达或超时，请检查 MYSQL_HOST 是否可解析、防火墙与安全组。'
        );
    }
    process.exit(1);
});
