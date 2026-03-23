-- 为 symbols 增加审计字段：插入/更新用户与更新时间。
-- 注意：该迁移按“一次性执行”设计，重复执行会因列已存在而报错。

ALTER TABLE symbols
  ADD COLUMN insert_user VARCHAR(255) NOT NULL DEFAULT 'LorryIsLuRui' AFTER usage_count,
  ADD COLUMN updated_user VARCHAR(255) NOT NULL DEFAULT 'LorryIsLuRui' AFTER insert_user,
  ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at;
