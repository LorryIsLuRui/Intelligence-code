import type { Pool, RowDataPacket } from 'mysql2/promise';
import { env } from '../config/env.js';
import { getMySqlPool } from '../db/mysql.js';
import type { CodeSymbol, SymbolType } from '../types/symbol.js';
import { createEmbeddingClient } from '../services/embeddingClient.js';
import { cosineSimilarity } from '../services/vectorMath.js';

interface SymbolRow extends RowDataPacket {
    id: number;
    name: string;
    type: SymbolType;
    category: string | null;
    path: string;
    description: string | null;
    content: string | null;
    meta: string | null;
    usage_count: number;
    created_at?: string | null;
    embedding?: unknown;
}

const inMemorySymbols: CodeSymbol[] = [
    {
        id: 1,
        name: 'FormInput',
        type: 'component',
        category: 'form',
        path: 'src/components/FormInput.tsx',
        description: 'A reusable form input with validation',
        content: null,
        meta: { props: ['value', 'onChange', 'error'], hooks: ['useForm'] },
        usageCount: 18,
        createdAt: new Date().toISOString(),
    },
    {
        id: 2,
        name: 'formatDate',
        type: 'util',
        category: 'date',
        path: 'src/utils/date.ts',
        description: 'Format date to YYYY-MM-DD',
        content: null,
        meta: { params: ['input'], returnType: 'string' },
        usageCount: 40,
        createdAt: new Date(
            Date.now() - 1000 * 60 * 60 * 24 * 30
        ).toISOString(),
    },
];

function parseEmbedding(raw: unknown): number[] | null {
    if (raw == null) return null;
    if (Array.isArray(raw)) {
        const nums = raw
            .map((x) => Number(x))
            .filter((n) => Number.isFinite(n));
        return nums.length === raw.length ? nums : null;
    }
    if (typeof raw === 'string') {
        try {
            const j = JSON.parse(raw) as unknown;
            if (!Array.isArray(j)) return null;
            const nums = j
                .map((x) => Number(x))
                .filter((n) => Number.isFinite(n));
            return nums.length === j.length ? nums : null;
        } catch {
            return null;
        }
    }
    return null;
}

function mapRow(
    row: SymbolRow,
    opts?: { includeEmbedding?: boolean }
): CodeSymbol {
    const base: CodeSymbol = {
        id: row.id,
        name: row.name,
        type: row.type,
        category: row.category,
        path: row.path,
        description: row.description,
        content: row.content,
        meta: row.meta ? JSON.parse(row.meta) : null,
        usageCount: row.usage_count,
        createdAt: row.created_at ?? null,
    };
    if (opts?.includeEmbedding) {
        base.embedding = parseEmbedding(row.embedding);
    }
    return base;
}

function getMetaArray(
    meta: Record<string, unknown> | null,
    key: string
): string[] {
    if (!meta) return [];
    const value = meta[key];
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === 'string');
}

export class SymbolRepository {
    private pool: Pool | null;

    constructor() {
        this.pool = getMySqlPool();
    }

    async search(query: string, type?: SymbolType): Promise<CodeSymbol[]> {
        if (!this.pool) {
            const q = query.toLowerCase();
            return inMemorySymbols.filter((s) => {
                const typeOk = type ? s.type === type : true;
                return (
                    typeOk &&
                    (s.name.toLowerCase().includes(q) ||
                        (s.description ?? '').toLowerCase().includes(q))
                );
            });
        }

        const params: Array<string> = [`%${query}%`];
        let sql = `
      SELECT id, name, type, category, path, description, content, CAST(meta AS CHAR) AS meta, usage_count, created_at
      FROM ${env.mysqlSymbolsTable}
      WHERE (name LIKE ? OR description LIKE ?)
    `;
        params.push(`%${query}%`);

        if (type) {
            sql += ' AND type = ?';
            params.push(type);
        }

        sql += ' ORDER BY usage_count DESC LIMIT 20';

        const [rows] = await this.pool.query<SymbolRow[]>(sql, params);
        return rows.map((r) => mapRow(r));
    }

    /**
     * Phase 5：对自然语言查询做向量检索，返回代码块与余弦相似度（已去掉 embedding 列便于 JSON 输出）。
     */
    async searchSemanticHits(
        query: string,
        opts?: { type?: SymbolType; candidateLimit?: number; limit?: number }
    ): Promise<Array<{ symbol: CodeSymbol; similarity: number }>> {
        if (!env.embeddingServiceUrl) {
            throw new Error(
                '语义检索需配置 EMBEDDING_SERVICE_URL 并启动嵌入服务'
            );
        }
        if (!this.pool) {
            return [];
        }

        const candidateLimit = opts?.candidateLimit ?? 3000;
        const limit = opts?.limit ?? 20;
        const type = opts?.type;

        const client = createEmbeddingClient(env.embeddingServiceUrl);
        const [queryVec] = await client.embed([query.trim()]);
        if (!queryVec?.length) {
            throw new Error('查询向量为空');
        }

        let sql = `
      SELECT id, name, type, category, path, description, content, CAST(meta AS CHAR) AS meta, usage_count, created_at, embedding
      FROM ${env.mysqlSymbolsTable}
      WHERE embedding IS NOT NULL
    `;
        const params: Array<string | number> = [];

        if (type) {
            sql += ' AND type = ?';
            params.push(type);
        }

        sql += ' ORDER BY usage_count DESC LIMIT ?';
        params.push(candidateLimit);

        const [rows] = await this.pool.query<SymbolRow[]>(sql, params);
        const withVec = rows
            .map((r) => mapRow(r, { includeEmbedding: true }))
            .filter(
                (s) => s.embedding && s.embedding.length === queryVec.length
            );

        return withVec
            .map((s) => {
                const sim = cosineSimilarity(queryVec, s.embedding!);
                const { embedding: _, ...rest } = s;
                return { symbol: rest as CodeSymbol, similarity: sim };
            })
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, limit);
    }

    async getByName(name: string): Promise<CodeSymbol | null> {
        if (!this.pool) {
            return (
                inMemorySymbols.find(
                    (s) => s.name.toLowerCase() === name.toLowerCase()
                ) ?? null
            );
        }

        const [rows] = await this.pool.query<SymbolRow[]>(
            `
      SELECT id, name, type, category, path, description, content, CAST(meta AS CHAR) AS meta, usage_count, created_at
      FROM ${env.mysqlSymbolsTable}
      WHERE name = ?
      LIMIT 1
      `,
            [name]
        );

        if (rows.length === 0) {
            return null;
        }

        return mapRow(rows[0]);
    }

    /**
     * 将指定代码块的 usage_count +1，用于用户采纳推荐后记录。
     */
    async incUsage(symbolId: number): Promise<boolean> {
        if (!this.pool) {
            // 内存模式：找到并 +1
            const idx = inMemorySymbols.findIndex((s) => s.id === symbolId);
            if (idx >= 0) {
                inMemorySymbols[idx].usageCount++;
                return true;
            }
            return false;
        }
        const [result] = await this.pool.query(
            `UPDATE ${env.mysqlSymbolsTable} SET usage_count = usage_count + 1 WHERE id = ?`,
            [symbolId]
        );
        return (result as { affectedRows: number }).affectedRows > 0;
    }

    async searchByStructure(
        fields: string[],
        opts?: { type?: SymbolType; category?: string; limit?: number }
    ): Promise<CodeSymbol[]> {
        const normalized = fields.map((f) => f.trim()).filter(Boolean);
        if (normalized.length === 0) return [];
        const type = opts?.type;
        const category = opts?.category?.trim();
        const limit = opts?.limit ?? 20;

        const matchesAll = (symbol: CodeSymbol) => {
            const typeOk = type ? symbol.type === type : true;
            const categoryOk = category
                ? (symbol.category ?? '')
                      .toLowerCase()
                      .includes(category.toLowerCase())
                : true;
            if (!typeOk || !categoryOk) return false;
            const propPool = [
                ...getMetaArray(symbol.meta, 'props'),
                ...getMetaArray(symbol.meta, 'params'),
                ...getMetaArray(symbol.meta, 'properties'),
                ...getMetaArray(symbol.meta, 'hooks'),
            ].map((v) => v.toLowerCase());
            return normalized.every((field) =>
                propPool.includes(field.toLowerCase())
            );
        };

        if (!this.pool) {
            return inMemorySymbols.filter(matchesAll).slice(0, limit);
        }

        const params: Array<string | number> = [];
        let sql = `
      SELECT id, name, type, category, path, description, content, CAST(meta AS CHAR) AS meta, usage_count, created_at
      FROM ${env.mysqlSymbolsTable}
      WHERE 1 = 1
    `;

        if (type) {
            sql += ' AND type = ?';
            params.push(type);
        }
        if (category) {
            sql += ' AND category LIKE ?';
            params.push(`%${category}%`);
        }
        sql += ' ORDER BY usage_count DESC LIMIT ?';
        params.push(Math.max(limit * 5, 50));

        const [rows] = await this.pool.query<SymbolRow[]>(sql, params);
        return rows
            .map((r) => mapRow(r))
            .filter(matchesAll)
            .slice(0, limit);
    }
}
