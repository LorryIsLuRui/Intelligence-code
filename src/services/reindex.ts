import { resolve } from "node:path";
import { env, validateEnv } from "../config/env.js";
import { getMySqlPool } from "../db/mysql.js";
import { indexProject } from "../indexer/indexProject.js";
import { upsertSymbols } from "../indexer/persistSymbols.js";

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
}

export async function runReindex(options: ReindexOptions = {}): Promise<ReindexResult> {
  validateEnv();
  const pool = getMySqlPool();
  if (!pool || !env.mysqlEnabled) {
    throw new Error("执行 reindex 前必须开启 MYSQL_ENABLED=true。");
  }

  await pool.query("SELECT 1");

  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const rows = await indexProject({
    projectRoot,
    globPatterns: options.globPatterns,
    ignore: options.ignore
  });

  if (!options.dryRun) {
    await upsertSymbols(pool, rows);
  }

  return {
    projectRoot,
    extractedCount: rows.length,
    upserted: !options.dryRun
  };
}
