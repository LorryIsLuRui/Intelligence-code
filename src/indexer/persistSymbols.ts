import type { Pool } from 'pg';
import type { IndexedSymbolRow } from './indexProject.js';
import { env } from '../config/env.js';
import { getAllTableSQLs } from '../db/schema.js';
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
    const actor = process.env.GITHUB_USERNAME?.trim() || 'system';
    const client = await pool.connect();
    try {
        // 确保 extension + 表 + 基础索引存在
        for (const sql of getAllTableSQLs()) {
            await client.query(sql);
        }

        await client.query('BEGIN');

        const t = env.symbolsTable;
        const sql = `
    INSERT INTO ${t}
      (name, type, category, path, description, content, meta,
       insert_user, updated_user, embedding, semantic_hash, file_hash, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::vector, $11, $12, $13)
    ON CONFLICT (path, name) DO UPDATE SET
      type          = EXCLUDED.type,
      category      = EXCLUDED.category,
      description   = EXCLUDED.description,
      content       = EXCLUDED.content,
      meta          = EXCLUDED.meta,
      updated_user  = EXCLUDED.updated_user,
      embedding     = CASE
                        WHEN EXCLUDED.embedding IS NOT NULL THEN EXCLUDED.embedding
                        WHEN EXCLUDED.semantic_hash != ${t}.semantic_hash THEN NULL
                        ELSE ${t}.embedding
                      END,
      semantic_hash = EXCLUDED.semantic_hash,
      file_hash     = EXCLUDED.file_hash,
      status        = CASE
                        WHEN EXCLUDED.embedding IS NOT NULL THEN ${SYMBOL_STATUS.ONLINE}
                        WHEN EXCLUDED.semantic_hash != ${t}.semantic_hash THEN ${SYMBOL_STATUS.PENDING}
                        ELSE ${t}.status
                      END,
      updated_at    = NOW()
  `;

        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const emb = embeddings?.[i];
            // pgvector 接受 "[x1,x2,...]" 格式字符串
            const vecStr = emb != null ? `[${emb.join(',')}]` : null;
            const statusVal =
                vecStr !== null ? SYMBOL_STATUS.ONLINE : SYMBOL_STATUS.PENDING;
            await client.query(sql, [
                r.name,
                r.type,
                r.category,
                r.path,
                r.description,
                r.content,
                JSON.stringify(r.meta),
                actor,
                actor,
                vecStr, // $10 → cast as vector, null 时写 NULL
                r.semantic_hash,
                r.file_hash,
                statusVal,
            ]);
        }

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}
