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
const THREADHOLD_SIMILARITY_BEFORE_RANKED = 0.5;
const TOP_K_FOR_RANKING = 100; // 进入复杂排序的候选数上限（语义相似度初筛后保留的结果数，过大会增加排序成本）

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
   * Phase 5：对自然语言查询做向量检索，启用分桶采样策略，返回代码
  块与余弦相似度。
   * 分桶策略：
   * - 第一层：按 category 占比计算每个分类应采样条数（保底10条）
   * - 第二层：每个 path 子桶内乱序后采样 Math.max(5,
  floor(catLimit / pathCount)) 条
  * 最终选择topK，进入排序
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
        const limit = opts?.limit ?? TOP_K_FOR_RANKING;
        const type = opts?.type;

        const client = createEmbeddingClient(env.embeddingServiceUrl);
        const [queryVec] = await client.embed([query.trim()]);
        if (!queryVec?.length) {
            throw new Error('查询向量为空');
        }
        // 查询足够的数据以支持分桶采样（3倍候选数以覆盖各桶）
        const fetchLimit = candidateLimit * 3;
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

        sql += ' DESC LIMIT ?';
        params.push(fetchLimit);

        const [rows] = await this.pool.query<SymbolRow[]>(sql, params);
        const withVec = rows
            .map((r) => mapRow(r, { includeEmbedding: true }))
            .filter(
                (s) => s.embedding && s.embedding.length === queryVec.length
            );
        // 分桶采样：按 category + path 两层分桶
        const sampled = this.bucketSampling(withVec, candidateLimit);
        return sampled
            .map((s) => {
                const sim = cosineSimilarity(queryVec, s.embedding!);
                const { embedding: _, ...rest } = s;
                return { symbol: rest as CodeSymbol, similarity: sim };
            })
            .filter((x) => x.similarity >= THREADHOLD_SIMILARITY_BEFORE_RANKED) // 初筛阈值，过滤掉明显不相关的结果
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, limit);
    }

    /**
   * 分桶采样核心逻辑
   * - 第一层：按 category 占比计算每个分类应采样条数（保底10条）
   * - 第二层：每个 path 子桶内乱序后采样 Math.max(5,
  floor(catLimit / pathCount)) 条
   */
    private bucketSampling(symbols: CodeSymbol[], limit: number): CodeSymbol[] {
        if (symbols.length === 0) return [];

        // 按 category 分组
        const categoryGroups = new Map<string, CodeSymbol[]>();
        for (const s of symbols) {
            const cat = s.category ?? '__null__';
            if (!categoryGroups.has(cat)) {
                categoryGroups.set(cat, []);
            }
            categoryGroups.get(cat)!.push(s);
        }

        const total = symbols.length;
        const sampled: CodeSymbol[] = [];

        // 第一层：按 category 占比计算采样数，保底10条
        for (const [, catSymbols] of categoryGroups) {
            const catCount = catSymbols.length;
            const catRatio = catCount / total;
            const catLimit = Math.max(10, Math.floor(limit * catRatio));

            // 按 path 分组（提取目录部分）
            const pathGroups = new Map<string, CodeSymbol[]>();
            for (const s of catSymbols) {
                const dir = s.path.includes('/')
                    ? s.path.slice(0, s.path.lastIndexOf('/'))
                    : '__root__';
                if (!pathGroups.has(dir)) {
                    pathGroups.set(dir, []);
                }
                pathGroups.get(dir)!.push(s);
            }

            const pathCount = pathGroups.size;
            const perPathSample = Math.max(5, Math.floor(catLimit / pathCount));

            // 第二层：每个 path 子桶内乱序后采样
            for (const pathSymbols of pathGroups.values()) {
                // 原地乱序（Fisher- Y ates）
                for (let i = pathSymbols.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [pathSymbols[i], pathSymbols[j]] = [
                        pathSymbols[j],
                        pathSymbols[i],
                    ];
                }

                const pathSampleCount = Math.min(
                    perPathSample,
                    pathSymbols.length
                );
                sampled.push(...pathSymbols.slice(0, pathSampleCount));

                if (sampled.length >= limit) break;
            }

            if (sampled.length >= limit) break;
        }

        return sampled.slice(0, limit);
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
