/**
 * 将内存中的索引行批量写入 MySQL `symbols` 表。
 */
import type { Pool } from "mysql2/promise";
import type { IndexedSymbolRow } from "./indexProject.js";

/**
 * 依赖表上 `(path, name)` 唯一键：新行插入，已存在则更新类型/描述/内容与 meta；**不**修改 `usage_count`。
 * @param rows 来自 `indexProject`；空数组时立即返回，不开启事务。
 * @param embeddings 与 `rows` 等长；某项为 `null` 表示本行不更新已有 `embedding`（新行则写入 NULL）。
 * @returns Promise 在提交成功时 resolve；任一行失败则整批回滚并抛出异常。
 */
export async function upsertSymbols(
  pool: Pool,
  rows: IndexedSymbolRow[],
  embeddings?: (number[] | null)[]
): Promise<void> {
  if (rows.length === 0) return;
  if (embeddings && embeddings.length !== rows.length) {
    throw new Error("upsertSymbols: embeddings length must match rows");
  }
  const actor = process.env.GITHUB_USERNAME?.trim() || "LorryIsLuRui";

  const sql = `
    INSERT INTO symbols (name, type, category, path, description, content, meta, insert_user, updated_user, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      type = VALUES(type),
      category = VALUES(category),
      description = VALUES(description),
      content = VALUES(content),
      meta = VALUES(meta),
      updated_user = VALUES(updated_user),
      embedding = CASE WHEN VALUES(embedding) IS NOT NULL THEN VALUES(embedding) ELSE embedding END
  `;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const emb = embeddings?.[i];
      const embJson =
        emb !== undefined && emb !== null ? JSON.stringify(emb) : null;
      await conn.query(sql, [
        r.name,
        r.type,
        r.category,
        r.path,
        r.description,
        r.content,
        JSON.stringify(r.meta),
        actor,
        actor,
        embJson
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
