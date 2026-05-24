-- 为 symbols 表添加 file_hash 和 semantic_hash 字段
-- 用于 CI 增量索引优化：跳过不必要的 embedding 计算

ALTER TABLE symbols
    ADD COLUMN file_hash VARCHAR(64) NULL COMMENT 'SHA256 of file content (for daily full scan)',
    ADD COLUMN semantic_hash VARCHAR(64) NULL COMMENT 'SHA256 of normalized AST signature';

-- 添加索引加速 hash 对比查询
ALTER TABLE symbols
    ADD INDEX idx_file_hash (file_hash),
    ADD INDEX idx_semantic_hash (semantic_hash);
