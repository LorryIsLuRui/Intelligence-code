/**
 * 将内存中的索引行批量写入 MySQL `symbols` 表。
 */
import type { Pool } from "mysql2/promise";
import type { IndexedSymbolRow } from "./indexProject.js";

/**
 * 依赖表上 `(path, name)` 唯一键：新行插入，已存在则更新类型/描述/内容与 meta；**不**修改 `usage_count`。
 * @param rows 来自 `indexProject`；空数组时立即返回，不开启事务。
 * @returns Promise 在提交成功时 resolve；任一行失败则整批回滚并抛出异常。
 */
export async function upsertSymbols(pool: Pool, rows: IndexedSymbolRow[]): Promise<void> {
  if (rows.length === 0) return;
  const actor = process.env.GITHUB_USERNAME?.trim() || "LorryIsLuRui";

  const sql = `
    INSERT INTO symbols (name, type, category, path, description, content, meta, insert_user, updated_user)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      type = VALUES(type),
      category = VALUES(category),
      description = VALUES(description),
      content = VALUES(content),
      meta = VALUES(meta),
      updated_user = VALUES(updated_user)
  `;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const r of rows) {
      await conn.query(sql, [
        r.name,
        r.type,
        r.category,
        r.path,
        r.description,
        r.content,
        JSON.stringify(r.meta),
        actor,
        actor
      ]);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}
