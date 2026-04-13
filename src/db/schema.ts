/**
 * 动态生成数据库表结构 SQL，表名可通过环境变量配置
 */
import { env } from '../config/env.js';

/** 获取 symbols 表的建表 SQL */
export function getSymbolsTableSQL(): string {
    const tableName = env.mysqlSymbolsTable;
    return `CREATE TABLE IF NOT EXISTS ${tableName} (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  type ENUM('component', 'function', 'type', 'class', 'interface', 'hook') NOT NULL,
  category VARCHAR(255) NULL,
  path TEXT NOT NULL,
  description TEXT NULL,
  content MEDIUMTEXT NULL,
  meta JSON NULL,
  usage_count INT NOT NULL DEFAULT 0,
  embedding JSON NULL COMMENT 'Phase 5: L2-normalized vector from Python embedding service (e.g. 384-dim MiniLM)',
  insert_user VARCHAR(255) NOT NULL DEFAULT 'LorryIsLuRui',
  updated_user VARCHAR(255) NOT NULL DEFAULT 'LorryIsLuRui',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  file_hash VARCHAR(64) NULL COMMENT '文件内容 SHA256',
  semantic_hash VARCHAR(64) NULL COMMENT 'normalized AST 语义模板 SHA256',
  UNIQUE KEY uk_symbols_path_name (path(512), name(255)),
  INDEX idx_file_hash (file_hash),
  INDEX idx_semantic_hash (semantic_hash)
)`;
}

/** 获取所有建表 SQL（可一次性执行） */
export function getAllTableSQLs(): string[] {
    return [getSymbolsTableSQL()];
}
