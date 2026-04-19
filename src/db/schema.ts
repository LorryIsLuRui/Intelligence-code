/**
 * 动态生成数据库表结构 SQL（PostgreSQL + pgvector），表名可通过环境变量配置
 */
import { env } from '../config/env.js';
import { DEFAULT_STATUS_ON_UPSERT } from '../config/symbolStatus.js';

/** 确保 vector 扩展已启用 */
export function getEnsureExtensionSQL(): string {
    return `CREATE EXTENSION IF NOT EXISTS vector`;
}

/** 获取 symbols 表的建表 SQL */
export function getSymbolsTableSQL(): string {
    const tableName = env.symbolsTable;
    return `CREATE TABLE IF NOT EXISTS ${tableName} (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  type          VARCHAR(50) NOT NULL,
  category      VARCHAR(255),
  path          TEXT NOT NULL,
  description   TEXT,
  content       TEXT,
  meta          JSONB,
  usage_count   INT NOT NULL DEFAULT 0,
  embedding     vector(384),
  insert_user   VARCHAR(255) NOT NULL DEFAULT 'system',
  updated_user  VARCHAR(255) NOT NULL DEFAULT 'system',
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  file_hash     VARCHAR(64),
  semantic_hash VARCHAR(64),
  status        SMALLINT NOT NULL DEFAULT ${DEFAULT_STATUS_ON_UPSERT},
  CONSTRAINT uk_${tableName}_path_name UNIQUE (path, name),
  CONSTRAINT chk_${tableName}_type CHECK (type IN ('component','function','type','class','interface','hook'))
)`;
}

/** 获取基础索引 SQL（不含 HNSW，HNSW 建议数据量 > 1000 后手动执行） */
export function getSymbolsIndexSQLs(): string[] {
    const t = env.symbolsTable;
    return [
        `CREATE INDEX IF NOT EXISTS idx_file_hash ON ${t}(file_hash)`,
        `CREATE INDEX IF NOT EXISTS idx_semantic_hash ON ${t}(semantic_hash)`,
        `CREATE INDEX IF NOT EXISTS idx_status ON ${t}(status)`,
    ];
}

/** 获取所有建表 SQL（extension + table + indexes，可逐条执行） */
export function getAllTableSQLs(): string[] {
    return [
        getEnsureExtensionSQL(),
        getSymbolsTableSQL(),
        ...getSymbolsIndexSQLs(),
    ];
}
