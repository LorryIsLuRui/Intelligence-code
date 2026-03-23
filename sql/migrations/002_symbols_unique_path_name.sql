-- 在已有库上补充与 schema.sql 一致的唯一索引（全新建库可跳过，schema.sql 已包含）。
-- 若 path+name 存在重复行，请先清理后再执行。

ALTER TABLE symbols
  ADD UNIQUE KEY uk_symbols_path_name (path(512), name(255));
