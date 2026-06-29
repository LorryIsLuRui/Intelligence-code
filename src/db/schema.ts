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
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(path, '')), 'C')
) STORED,
  status        SMALLINT NOT NULL DEFAULT ${DEFAULT_STATUS_ON_UPSERT},
  CONSTRAINT uk_${tableName}_path_name UNIQUE (path, name),
  CONSTRAINT chk_${tableName}_type CHECK (type IN ('component','function','type','class','interface','hook'))
)`;
}

/** 获取基础索引 + HNSW 向量索引 + BM25 全文搜索索引 SQL */
export function getSymbolsIndexSQLs(): string[] {
    const t = env.symbolsTable;
    return [
        `CREATE INDEX IF NOT EXISTS idx_file_hash ON ${t}(file_hash)`,
        `CREATE INDEX IF NOT EXISTS idx_semantic_hash ON ${t}(semantic_hash)`,
        `CREATE INDEX IF NOT EXISTS idx_status ON ${t}(status)`,
        // 会用type硬过滤，建立索引 标准 B-Tree 索引
        `CREATE INDEX IF NOT EXISTS idx_${t}_type ON ${t}(type)`,
        // HNSW 索引：将空间中相近的向量编组、连线、分层，大幅加速 `<=>` cosine 距离检索。
        //      参数说明：m=16（每层最多连接数），ef_construction=64（建索引时动态候选集大小）。
        //      数据量 < 1000 时暴力扫描可能更快，建议数据量 > 1000 或已有性能瓶颈时启用。
        `CREATE INDEX IF NOT EXISTS idx_${t}_embedding_hnsw ON ${t} USING hnsw (embedding vector_cosine_ops) WITH (m = 32, ef_construction = 128)`,
        // BM25 全文搜索：tsvector 生成列 + GIN 索引。
        //      name 权重 A（最高），description 权重 B，path 权重 C。
        `CREATE INDEX IF NOT EXISTS idx_${t}_search_vector ON ${t} USING GIN (search_vector)`,
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

export function getChunksTableSQL(): string {
    const tableName = env.chunksTable;
    return `CREATE TABLE IF NOT EXISTS ${tableName} (
  id            SERIAL PRIMARY KEY,
  source_id     VARCHAR(255),
  title         TEXT NOT NULL,
  path          TEXT NOT NULL,
  chunk_index   INT NOT NULL,
  chunk_count   INT NOT NULL,
  content       TEXT NOT NULL,
  summary       TEXT,
  category      VARCHAR(255),
  meta          JSONB,
  embedding     vector(384),
  semantic_hash VARCHAR(64) NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
            setweight(to_tsvector('simple', coalesce(content, '')), 'B') ||
            setweight(to_tsvector('simple', coalesce(summary, '')), 'C') ||
            setweight(to_tsvector('simple', coalesce(path, '')), 'D')
    ) STORED,
  status        SMALLINT NOT NULL DEFAULT ${DEFAULT_STATUS_ON_UPSERT},
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uk_${tableName}_path_chunk UNIQUE (path, chunk_index)
)`;
}

export function getChunksIndexSQLs(): string[] {
    const t = env.chunksTable;
    return [
        `CREATE INDEX IF NOT EXISTS idx_${t}_source_id ON ${t}(source_id)`,
        `CREATE INDEX IF NOT EXISTS idx_${t}_semantic_hash ON ${t}(semantic_hash)`,
        `CREATE INDEX IF NOT EXISTS idx_${t}_status ON ${t}(status)`,
        `CREATE INDEX IF NOT EXISTS idx_${t}_path ON ${t}(path)`,
        `CREATE INDEX IF NOT EXISTS idx_${t}_embedding_hnsw ON ${t} USING hnsw (embedding vector_cosine_ops)`,
        // BM25 全文搜索：title 权重 A，content 权重 B，summary 权重 C，path 权重 D。
        //      Postgres 自带的分词器（如 'english'）会做词干提取（Stemming）。比如把 components 变成 compon，把 running 变成 run。
        //      而 'simple' 分词器绝对不做任何词干变形，只做简单的空格/标点切分，并全部转为小写。
        `CREATE INDEX IF NOT EXISTS idx_${t}_search_vector ON ${t} USING GIN (search_vector)`,
    ];
}

export function getAllChunkTableSQLs(): string[] {
    return [
        getEnsureExtensionSQL(),
        getChunksTableSQL(),
        ...getChunksIndexSQLs(),
    ];
}
