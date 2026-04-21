-- 添加 status 字段用于大仓问题优化
-- status: 0-offline(删除), 1-pending(待处理), 2-online(可用), 3-error(错误)

ALTER TABLE symbols
    ADD COLUMN status TINYINT NOT NULL DEFAULT 1 COMMENT '状态: 0-offline(删除), 1-pending(待处理), 2-online(可用), 3-error(错误)';

-- 为 status 添加索引以加速查询
ALTER TABLE symbols
    ADD INDEX idx_status (status);

-- 将历史存量数据整体标记为 online，避免迁移后被检索过滤掉
UPDATE symbols SET status = 2;