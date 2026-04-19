import pg from 'pg';
import { env } from '../config/env.js';
import { getPool } from '../db/postgres.js';
import type { CodeSymbol, SymbolType } from '../types/symbol.js';
import { createEmbeddingClient } from '../services/embeddingClient.js';
import { SEARCHABLE_STATUS } from '../config/symbolStatus.js';

interface SymbolRow {
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
    embedding?: string | null; // pgvector 返回字符串 "[x1,x2,...]"
    similarity?: string; // searchSemanticHits 时附加
}
const SIMILARITY_THRESHOLD = 0.5;
const TOP_K = 20;

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
        type: 'function',
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
            // pgvector 返回 "[x1,x2,...]"，恰好是合法 JSON 数组
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
    private pool: pg.Pool | null;

    constructor() {
        this.pool = getPool();
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

        const params: Array<string | number> = [
            `%${query}%`,
            SEARCHABLE_STATUS,
        ];
        let sql = `
      SELECT id, name, type, category, path, description, content, meta::text AS meta, usage_count, created_at
      FROM ${env.symbolsTable}
      WHERE (name ILIKE $1 OR description ILIKE $1)
        AND status = $2
    `;

        if (type) {
            params.push(type);
            sql += ` AND type = $${params.length}`;
        }

        sql += ' ORDER BY usage_count DESC LIMIT 20';

        const { rows } = await this.pool.query<SymbolRow>(sql, params);
        return rows.map((r) => mapRow(r));
    }

    /**
     * 语义向量检索：将 query 嵌入后用 pgvector <=> 运算符（cosine distance）在数据库内完成相似度排序。
     * 不再需要在 Node 拉取全量向量做内存计算。
     */
    async searchSemanticHits(
        query: string,
        opts?: { type?: SymbolType; limit?: number }
    ): Promise<Array<{ symbol: CodeSymbol; similarity: number }>> {
        if (!env.embeddingServiceUrl) {
            throw new Error(
                '语义检索需配置 EMBEDDING_SERVICE_URL 并启动嵌入服务'
            );
        }
        if (!this.pool) {
            return [];
        }

        const limit = opts?.limit ?? TOP_K;
        const client = createEmbeddingClient(env.embeddingServiceUrl);
        const [queryVec] = await client.embed([query.trim()]);
        if (!queryVec?.length) {
            throw new Error('查询向量为空');
        }

        // pgvector 向量字面量格式：[x1,x2,...]
        const vecLiteral = `[${queryVec.join(',')}]`;
        const params: unknown[] = [vecLiteral, SEARCHABLE_STATUS];

        // 1 - cosine_distance = cosine_similarity；多取一倍候选后在应用层过阈值
        let sql = `
      SELECT id, name, type, category, path, description, content, meta::text AS meta,
             usage_count, created_at,
             1 - (embedding <=> $1::vector) AS similarity
      FROM ${env.symbolsTable}
      WHERE embedding IS NOT NULL
        AND status = $2
    `;

        if (opts?.type) {
            params.push(opts.type);
            sql += ` AND type = $${params.length}`;
        }

        params.push(limit * 2); // 多取一倍以便 SIMILARITY_THRESHOLD 过滤后仍有足量结果
        sql += ` ORDER BY embedding <=> $1::vector LIMIT $${params.length}`;

        const { rows } = await this.pool.query<
            SymbolRow & { similarity: string }
        >(sql, params);
        return rows
            .map((r) => ({
                symbol: mapRow(r),
                similarity: Number(r.similarity),
            }))
            .filter((x) => x.similarity >= SIMILARITY_THRESHOLD)
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

        const { rows } = await this.pool.query<SymbolRow>(
            `
      SELECT id, name, type, category, path, description, content, meta::text AS meta, usage_count, created_at
      FROM ${env.symbolsTable}
      WHERE name = $1
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
        const result = await this.pool.query(
            `UPDATE ${env.symbolsTable} SET usage_count = usage_count + 1 WHERE id = $1`,
            [symbolId]
        );
        return result.rowCount !== null && result.rowCount > 0;
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
      SELECT id, name, type, category, path, description, content, meta::text AS meta, usage_count, created_at
      FROM ${env.symbolsTable}
      WHERE 1 = 1
    `;

        if (type) {
            params.push(type);
            sql += ` AND type = $${params.length}`;
        }
        if (category) {
            params.push(`%${category}%`);
            sql += ` AND category ILIKE $${params.length}`;
        }
        params.push(Math.max(limit * 5, 50));
        sql += ` ORDER BY usage_count DESC LIMIT $${params.length}`;

        const { rows } = await this.pool.query<SymbolRow>(sql, params);
        return rows
            .map((r) => mapRow(r))
            .filter(matchesAll)
            .slice(0, limit);
    }
}
