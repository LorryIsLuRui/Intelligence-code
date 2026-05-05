import pg from 'pg';
import { env } from '../config/env.js';
import { CHUNK_SIMILARITY_THRESHOLD, CHUNK_TOP_K } from '../config/tuning.js';
import { SEARCHABLE_STATUS, SYMBOL_STATUS } from '../config/symbolStatus.js';
import { getPool } from '../db/postgres.js';
import { getAllChunkTableSQLs } from '../db/schema.js';
import { buildDocumentChunks } from '../indexer/chunkText.js';
import {
    createEmbeddingClient,
    embedAll,
} from '../services/embeddingClient.js';
import type {
    BuiltDocumentChunk,
    ChunkedDocumentInput,
    ChunkingOptions,
    StoredDocumentChunk,
} from '../types/chunk.js';

/**
 * ChunkRepository: 文档分块入库与语义召回。
 *
 * 写入流程（upsertDocument）:
 * 1. 使用 buildDocumentChunks 按结构切分（标题/段落/代码块）+ overlap 生成多个 chunk。
 * 2. 若配置了 EMBEDDING_SERVICE_URL，批量为每个 chunk 生成 embedding。
 * 3. 以 path 为文档主键先删后插，写入 path + chunk_index，保证同一路径只有最新分块。
 * 4. embedding 存在则 status=ONLINE；否则 status=PENDING，待后续补向量。
 *
 * 检索流程（searchSemantic + getAdjacentChunks）:
 * 1. 将查询语句向量化。
 * 2. 在 chunks 表中用 pgvector cosine 距离排序，返回 topK 相关 chunk。
 * 3. 生成回答时可按命中 chunk 的 path/chunk_index 调 getAdjacentChunks 做邻块扩展，补上下文。
 */

interface ChunkRow {
    id: number;
    source_id: string | null;
    title: string;
    path: string;
    chunk_index: number;
    chunk_count: number;
    content: string;
    summary: string | null;
    category: string | null;
    meta: string | null;
    embedding?: string | null;
    semantic_hash: string;
    status: number;
    created_at?: string | null;
    updated_at?: string | null;
    similarity?: string;
}

// 统一解析 pgvector 返回值，兼容字符串格式与数组格式。
function parseEmbedding(raw: unknown): number[] | null {
    if (raw == null) return null;
    if (Array.isArray(raw)) {
        const nums = raw.map((item) => Number(item)).filter(Number.isFinite);
        return nums.length === raw.length ? nums : null;
    }
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw) as unknown;
            return parseEmbedding(parsed);
        } catch {
            return null;
        }
    }
    return null;
}

// 将数据库行映射为业务层 chunk 对象。
function toStoredChunk(row: ChunkRow): StoredDocumentChunk {
    return {
        id: row.id,
        sourceId: row.source_id,
        title: row.title,
        path: row.path,
        chunkIndex: row.chunk_index,
        chunkCount: row.chunk_count,
        content: row.content,
        summary: row.summary,
        category: row.category,
        meta: row.meta ? JSON.parse(row.meta) : null,
        semanticHash: row.semantic_hash,
        embedding: parseEmbedding(row.embedding),
        similarity: row.similarity ? Number(row.similarity) : undefined,
        createdAt: row.created_at ?? null,
        updatedAt: row.updated_at ?? null,
    };
}

// 保留标题/路径/摘要：chunk截取/正文：完整chunk信息
function chunkToEmbeddingText(chunk: BuiltDocumentChunk): string {
    return [chunk.title, chunk.path, chunk.summary ?? '', chunk.content]
        .filter(Boolean)
        .join('\n');
}

export class ChunkRepository {
    private pool: pg.Pool | null;

    constructor() {
        this.pool = getPool();
    }

    // 确保 chunk 表和索引存在，便于独立运行写入流程。
    async ensureSchema(): Promise<void> {
        if (!this.pool) return;
        for (const sql of getAllChunkTableSQLs()) {
            await this.pool.query(sql);
        }
    }

    async upsertDocument(
        document: ChunkedDocumentInput,
        options: ChunkingOptions = {}
    ): Promise<StoredDocumentChunk[]> {
        if (!this.pool) return [];

        await this.ensureSchema();
        // 先做语义切分，再加 overlap，得到一个文档的 chunk 列表。
        const built = buildDocumentChunks(document, options);
        if (built.length === 0) return [];

        let embeddings: Array<number[] | null> = built.map(() => null);
        if (env.embeddingServiceUrl) {
            // 批量 embedding，减少网络往返和 API 调用开销。
            const client = createEmbeddingClient(env.embeddingServiceUrl);
            embeddings = await embedAll(
                client,
                built.map(chunkToEmbeddingText)
            );
        }

        const db = await this.pool.connect();
        try {
            await db.query('BEGIN');
            // 先删旧版本再写新版本，避免同 path 的历史 chunk 混入召回。
            const existing = await db.query<{ id: number }>(
                `SELECT id FROM ${env.chunksTable} WHERE path = $1`,
                [document.path]
            );
            if (existing.rowCount && existing.rowCount > 0) {
                await db.query(
                    `DELETE FROM ${env.chunksTable} WHERE path = $1`,
                    [document.path]
                );
            }

            const sql = `
                INSERT INTO ${env.chunksTable}
                  (source_id, title, path, chunk_index, chunk_count, content, summary, category, meta,
                   embedding, semantic_hash, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::vector, $11, $12)
                RETURNING id, source_id, title, path, chunk_index, chunk_count, content, summary, category,
                          meta::text AS meta, embedding, semantic_hash, status, created_at, updated_at
            `;

            const inserted: StoredDocumentChunk[] = [];
            for (let index = 0; index < built.length; index += 1) {
                const chunk = built[index];
                const embedding = embeddings[index];
                const vecLiteral = Array.isArray(embedding)
                    ? `[${embedding.join(',')}]`
                    : null;
                // 无向量时写为 pending，后续可以复用 worker 补齐向量。
                const { rows } = await db.query<ChunkRow>(sql, [
                    chunk.sourceId,
                    chunk.title,
                    chunk.path,
                    chunk.chunkIndex,
                    chunk.chunkCount,
                    chunk.content,
                    chunk.summary,
                    chunk.category,
                    JSON.stringify(chunk.meta),
                    vecLiteral,
                    chunk.semanticHash,
                    vecLiteral ? SYMBOL_STATUS.ONLINE : SYMBOL_STATUS.PENDING,
                ]);
                inserted.push(toStoredChunk(rows[0]));
            }
            await db.query('COMMIT');
            return inserted;
        } catch (error) {
            await db.query('ROLLBACK');
            throw error;
        } finally {
            db.release();
        }
    }

    async searchSemantic(
        query: string,
        opts?: { limit?: number; path?: string }
    ): Promise<StoredDocumentChunk[]> {
        if (!env.embeddingServiceUrl) {
            throw new Error('语义 chunk 检索需配置 EMBEDDING_SERVICE_URL');
        }
        if (!this.pool) return [];

        const limit = opts?.limit ?? CHUNK_TOP_K;
        const client = createEmbeddingClient(env.embeddingServiceUrl);
        // 查询先向量化，再在数据库中用 pgvector 做相似度排序。
        const [queryVec] = await client.embed([query.trim()]);
        if (!queryVec?.length) {
            throw new Error('查询向量为空');
        }

        const params: unknown[] = [
            `[${queryVec.join(',')}]`,
            SEARCHABLE_STATUS,
        ];
        let sql = `
            SELECT id, source_id, title, path, chunk_index, chunk_count, content, summary, category,
                   meta::text AS meta, embedding, semantic_hash, status, created_at, updated_at,
                   1 - (embedding <=> $1::vector) AS similarity
            FROM ${env.chunksTable}
            WHERE embedding IS NOT NULL
              AND status = $2
        `;

        if (opts?.path) {
            params.push(opts.path);
            sql += ` AND path = $${params.length}`;
        }

        params.push(limit * 2);
        sql += ` ORDER BY embedding <=> $1::vector LIMIT $${params.length}`;

        const { rows } = await this.pool.query<ChunkRow>(sql, params);
        return rows
            .map(toStoredChunk)
            .filter(
                (chunk) => (chunk.similarity ?? 0) >= CHUNK_SIMILARITY_THRESHOLD
            )
            .slice(0, limit);
    }

    // 命中 chunk 后取前后邻块，提升回答时上下文完整性。
    async getAdjacentChunks(
        path: string,
        chunkIndex: number,
        radius = 1
    ): Promise<StoredDocumentChunk[]> {
        if (!this.pool) return [];
        const { rows } = await this.pool.query<ChunkRow>(
            `
                SELECT id, source_id, title, path, chunk_index, chunk_count, content, summary, category,
                       meta::text AS meta, embedding, semantic_hash, status, created_at, updated_at
                FROM ${env.chunksTable}
                WHERE path = $1 AND chunk_index BETWEEN $2 AND $3
                ORDER BY chunk_index ASC
            `,
            [path, Math.max(0, chunkIndex - radius), chunkIndex + radius]
        );
        return rows.map(toStoredChunk);
    }
}
