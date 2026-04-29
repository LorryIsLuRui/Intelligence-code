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
const SIMILARITY_THRESHOLD = 0;
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

function extractSearchTokens(query: string): string[] {
    const tokens = new Set<string>();
    const normalized = query.trim().toLowerCase();

    for (const match of normalized.matchAll(/[a-z0-9_]+/g)) {
        if (match[0].length >= 2) tokens.add(match[0]);
    }

    for (const match of query.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
        const text = match[0];
        for (let index = 0; index < text.length - 1; index += 1) {
            tokens.add(text.slice(index, index + 2));
        }
    }

    return [...tokens];
}

function buildSearchText(symbol: CodeSymbol): string {
    return [
        symbol.name,
        symbol.path,
        symbol.description ?? '',
        JSON.stringify(symbol.meta ?? {}),
    ]
        .join(' ')
        .toLowerCase();
}

function countTokenMatches(text: string, tokens: string[]): number {
    return tokens.reduce(
        (count, token) =>
            text.includes(token.toLowerCase()) ? count + 1 : count,
        0
    );
}

export class SymbolRepository {
    private pool: pg.Pool | null;

    constructor() {
        this.pool = getPool();
    }

    async search(query: string, type?: SymbolType): Promise<CodeSymbol[]> {
        console.error(
            '[code-intelligence-mcp] repository.search.start query=%s type=%s table=%s searchableStatus=%s hasPool=%s',
            query,
            type ?? '',
            env.symbolsTable,
            String(SEARCHABLE_STATUS),
            String(Boolean(this.pool))
        );

        if (!this.pool) {
            const q = query.toLowerCase();
            const tokens = extractSearchTokens(query);
            const matched = inMemorySymbols.filter((s) => {
                const typeOk = type ? s.type === type : true;
                const text = buildSearchText(s);
                return (
                    typeOk &&
                    (text.includes(q) || countTokenMatches(text, tokens) >= 2)
                );
            });
            console.error(
                '[code-intelligence-mcp] repository.search.memory count=%s top=%s',
                String(matched.length),
                JSON.stringify(
                    matched.slice(0, 3).map((s) => ({
                        id: s.id,
                        name: s.name,
                        path: s.path,
                    }))
                )
            );
            return matched;
        }

        const tokens = extractSearchTokens(query);
        const params: Array<string | number> = [
            `%${query}%`,
            SEARCHABLE_STATUS,
        ];
        let sql = `
      SELECT id, name, type, category, path, description, content, meta::text AS meta, usage_count, created_at
      FROM ${env.symbolsTable}
            WHERE (
              name ILIKE $1 OR
              description ILIKE $1 OR
              path ILIKE $1 OR
              meta::text ILIKE $1
            )
        AND status = $2
    `;

        if (tokens.length) {
            const tokenClauses = tokens.map((token) => {
                // 每个query token都要在name/description/path/meta中至少匹配一次才算匹配，来提升搜索的准确度，避免单个token过于泛匹配导致的排名干扰
                params.push(`%${token}%`);
                const index = params.length;
                return `name ILIKE $${index} OR description ILIKE $${index} OR path ILIKE $${index} OR meta::text ILIKE $${index}`;
            });
            sql = `
      SELECT id, name, type, category, path, description, content, meta::text AS meta, usage_count, created_at
      FROM ${env.symbolsTable}
            WHERE (
              name ILIKE $1 OR
              description ILIKE $1 OR
              path ILIKE $1 OR
              meta::text ILIKE $1 OR
              (${tokenClauses.join(' OR ')})
            )
        AND status = $2
    `;
        }

        if (type) {
            params.push(type);
            sql += ` AND type = $${params.length}`;
        }

        sql += ' ORDER BY usage_count DESC LIMIT 20';

        const { rows } = await this.pool.query<SymbolRow>(sql, params);
        console.error(
            '[code-intelligence-mcp] repository.search.db table=%s rows=%s top=%s note=name/description only',
            env.symbolsTable,
            String(rows.length),
            JSON.stringify(
                rows.slice(0, 3).map((r) => ({
                    id: r.id,
                    name: r.name,
                    path: r.path,
                    type: r.type,
                }))
            )
        );
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
        console.error(
            '[code-intelligence-mcp] repository.searchSemanticHits.start query=%s type=%s table=%s limit=%s threshold=%s searchableStatus=%s hasPool=%s',
            query,
            opts?.type ?? '',
            env.symbolsTable,
            String(opts?.limit ?? TOP_K),
            String(SIMILARITY_THRESHOLD),
            String(SEARCHABLE_STATUS),
            String(Boolean(this.pool))
        );

        if (!env.embeddingServiceUrl) {
            console.error(
                '[code-intelligence-mcp] repository.searchSemanticHits.error missingEmbeddingServiceUrl'
            );
            throw new Error(
                '语义检索需配置 EMBEDDING_SERVICE_URL 并启动嵌入服务'
            );
        }
        if (!this.pool) {
            console.error(
                '[code-intelligence-mcp] repository.searchSemanticHits.noPool returnEmpty'
            );
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
        const mapped = rows.map((r) => ({
            symbol: mapRow(r),
            similarity: Number(r.similarity),
        }));
        const passed = mapped.filter(
            (x) => x.similarity >= SIMILARITY_THRESHOLD
        );

        console.error(
            '[code-intelligence-mcp] repository.searchSemanticHits.db table=%s rawRows=%s passedThreshold=%s topRaw=%s',
            env.symbolsTable,
            String(rows.length),
            String(passed.length),
            JSON.stringify(
                mapped.slice(0, 5).map((x) => ({
                    id: x.symbol.id,
                    name: x.symbol.name,
                    path: x.symbol.path,
                    similarity: Number(x.similarity.toFixed(4)),
                }))
            )
        );

        return passed
            .map((r) => ({
                symbol: r.symbol,
                similarity: r.similarity,
            }))
            .slice(0, limit);
    }

    async getByName(name: string): Promise<CodeSymbol | null> {
        console.error(
            '[code-intelligence-mcp] repository.getByName.start name=%s table=%s hasPool=%s',
            name,
            env.symbolsTable,
            String(Boolean(this.pool))
        );

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

        console.error(
            '[code-intelligence-mcp] repository.getByName.db table=%s rows=%s',
            env.symbolsTable,
            String(rows.length)
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
        console.error(
            '[code-intelligence-mcp] repository.searchByStructure.start fields=%s type=%s category=%s table=%s limit=%s hasPool=%s',
            JSON.stringify(fields),
            opts?.type ?? '',
            opts?.category ?? '',
            env.symbolsTable,
            String(opts?.limit ?? 20),
            String(Boolean(this.pool))
        );

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
            const matched = inMemorySymbols.filter(matchesAll).slice(0, limit);
            console.error(
                '[code-intelligence-mcp] repository.searchByStructure.memory matched=%s top=%s',
                String(matched.length),
                JSON.stringify(
                    matched.slice(0, 3).map((s) => ({
                        id: s.id,
                        name: s.name,
                        path: s.path,
                    }))
                )
            );
            return matched;
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
        const mapped = rows.map((r) => mapRow(r));
        const filtered = mapped.filter(matchesAll).slice(0, limit);

        console.error(
            '[code-intelligence-mcp] repository.searchByStructure.db table=%s scanned=%s matched=%s top=%s',
            env.symbolsTable,
            String(rows.length),
            String(filtered.length),
            JSON.stringify(
                filtered.slice(0, 3).map((s) => ({
                    id: s.id,
                    name: s.name,
                    path: s.path,
                }))
            )
        );

        return filtered;
    }
}
