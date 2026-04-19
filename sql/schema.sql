-- PostgreSQL + pgvector schema
-- 可通过 SYMBOLS_TABLE 环境变量或直接修改表名来创建不同项目的表
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS symbols (
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
  status        SMALLINT NOT NULL DEFAULT 1,
  CONSTRAINT uk_symbols_path_name UNIQUE (path, name),
  CONSTRAINT chk_type CHECK (type IN ('component','function','type','class','interface','hook'))
);

CREATE INDEX IF NOT EXISTS idx_file_hash     ON symbols(file_hash);
CREATE INDEX IF NOT EXISTS idx_semantic_hash ON symbols(semantic_hash);
CREATE INDEX IF NOT EXISTS idx_status        ON symbols(status);

-- HNSW \u8fd1\u4f3c\u6700\u8fd1\u90bb\u7d22\u5f15\uff08cosine \u8ddd\u79bb\uff09
-- \u5efa\u8bae\u6570\u636e\u91cf > 1000 \u540e\u6267\u884c\uff1b\u521d\u59cb\u65f6\u53ef\u6ce8\u91ca\u6389\uff0c\u5de5\u4f5c\u8fdb\u5165\u7a33\u5b9a\u540e\u518d\u5f00\u542f
-- CREATE INDEX IF NOT EXISTS idx_embedding_hnsw
--   ON symbols USING hnsw (embedding vector_cosine_ops)
--   WITH (m = 16, ef_construction = 64);
