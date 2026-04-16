import type { Pool } from 'mysql2/promise';
import type { IndexedSymbolRow } from './indexProject.js';
import { env } from '../config/env.js';
import { getSymbolsTableSQL } from '../db/schema.js';
import { SYMBOL_STATUS } from '../config/symbolStatus.js';

/**
 * 依赖表上 `(path, name)` 唯一键：新行插入，已存在则更新类型/描述/内容与 meta；**不**修改 `usage_count`。
 * @param rows 来自 `indexProject`；空数组时立即返回，不开启事务。
 * @param embeddings 与 `rows` 等长；某项为 `null` 表示本行不更新已有 `embedding`（新行则写入 NULL）。
 *   - 有值 → status 置为 online(2)
 *   - null  → 新行写 pending(1)，已有行保持原 status
 */
export async function upsertSymbols(
    pool: Pool,
    rows: IndexedSymbolRow[],
    embeddings?: (number[] | null)[]
): Promise<void> {
    if (rows.length === 0) return;
    if (embeddings && embeddings.length !== rows.length) {
        throw new Error('upsertSymbols: embeddings length must match rows');
    }
    const actor = process.env.GITHUB_USERNAME?.trim() || 'LorryIsLuRui';
    await pool.query(getSymbolsTableSQL()); // 确保表存在
    const sql = `
    INSERT INTO ${env.mysqlSymbolsTable}
      (name, type, category, path, description, content, meta,
       insert_user, updated_user, embedding, semantic_hash, file_hash, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      type          = VALUES(type),
      category      = VALUES(category),
      description   = VALUES(description),
      content       = VALUES(content),
      meta          = VALUES(meta),
      updated_user  = VALUES(updated_user),
      embedding     = CASE
                        WHEN VALUES(embedding) IS NOT NULL THEN VALUES(embedding)
                        WHEN VALUES(semantic_hash) != semantic_hash THEN NULL
                        ELSE embedding
                      END,
      semantic_hash = VALUES(semantic_hash),
      file_hash     = VALUES(file_hash),
      status        = CASE
                        WHEN VALUES(embedding) IS NOT NULL THEN ${SYMBOL_STATUS.ONLINE}
                        WHEN VALUES(semantic_hash) != semantic_hash THEN ${SYMBOL_STATUS.PENDING}
                        ELSE status
                      END
  `;

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const emb = embeddings?.[i];
            const embJson =
                emb !== undefined && emb !== null ? JSON.stringify(emb) : null;
            // 新行：有 embedding 则直接 online，否则 pending
            const statusVal =
                embJson !== null ? SYMBOL_STATUS.ONLINE : SYMBOL_STATUS.PENDING;
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
                embJson,
                r.semantic_hash,
                r.file_hash,
                statusVal,
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
