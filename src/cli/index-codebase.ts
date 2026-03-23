#!/usr/bin/env node
/**
 * Phase 2 CLI：扫描代码库并写入 MySQL `symbols`（需 `MYSQL_ENABLED=true`）。
 */
import { resolve } from "node:path";
import dotenv from "dotenv";
import { validateEnv } from "../config/env.js";
import { getMySqlPool } from "../db/mysql.js";
import { indexProject } from "../indexer/indexProject.js";
import { upsertSymbols } from "../indexer/persistSymbols.js";

dotenv.config();

/**
 * 入口：校验环境 → 连接池 → 按 `INDEX_*` 调用 `indexProject` → `upsertSymbols`。
 * 进度与统计输出到 **stderr**，避免占用 stdout（与 MCP 混用时更安全）。
 * 进程退出码：成功 `0`，无 MySQL 或异常 `1`。
 */
async function main() {
  validateEnv();

  const pool = getMySqlPool();
  if (!pool) {
    console.error(
      "[index] MYSQL_ENABLED 必须为 true，并配置 MYSQL_HOST / MYSQL_USER / MYSQL_DATABASE 等。详见 .env.example"
    );
    process.exit(1);
  }

  const host = process.env.MYSQL_HOST ?? "127.0.0.1";
  const port = process.env.MYSQL_PORT ?? "3306";
  console.error(`[index] connecting MySQL ${host}:${port} ...`);
  await pool.query("SELECT 1");

  const projectRoot = resolve(process.env.INDEX_ROOT ?? process.cwd());
  const globPatterns = process.env.INDEX_GLOB
    ? process.env.INDEX_GLOB.split(",").map((s) => s.trim())
    : undefined;
  const ignore = process.env.INDEX_IGNORE
    ? process.env.INDEX_IGNORE.split(",").map((s) => s.trim())
    : undefined;

  console.error(`[index] projectRoot=${projectRoot}`);
  const rows = await indexProject({ projectRoot, globPatterns, ignore });
  console.error(`[index] extracted ${rows.length} symbol(s)`);

  await upsertSymbols(pool, rows);
  console.error("[index] upserted into MySQL");
}

main().catch((err: unknown) => {
  console.error("[index] failed:", err);
  const anyErr = err as { code?: string; errno?: number };
  if (anyErr.code === "ECONNREFUSED") {
    const host = process.env.MYSQL_HOST ?? "127.0.0.1";
    const port = process.env.MYSQL_PORT ?? "3306";
    console.error(
      `[index] 原因: 无法连接 ${host}:${port}（连接被拒绝）。请先在本机启动 MySQL/MariaDB，或把 .env 里的 MYSQL_HOST / MYSQL_PORT 改成实际地址。macOS 可用 brew services start mysql 等方式启动。`
    );
  } else if (anyErr.code === "ER_ACCESS_DENIED_ERROR") {
    console.error("[index] 原因: 用户名或密码错误，请检查 MYSQL_USER / MYSQL_PASSWORD。");
  } else if (anyErr.code === "ENOTFOUND" || anyErr.code === "ETIMEDOUT") {
    console.error("[index] 原因: 网络不可达或超时，请检查 MYSQL_HOST 是否可解析、防火墙与安全组。");
  }
  process.exit(1);
});
