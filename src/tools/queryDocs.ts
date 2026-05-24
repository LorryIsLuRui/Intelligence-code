/**
 * query_docs MCP 工具：完整的 RAG 检索 + 上下文组装入口。
 *
 * 调用链：
 *   query
 *     → ChunkRepository.searchSemantic()   向量检索 topK chunk
 *     → ContextAssembler.assemble()         邻块扩展 → 去重 → 字符预算截断 → 文本渲染
 *     → 返回 contextText + sources          供 LLM 合成最终回答
 *
 * 为什么工具只返回 contextText 而不直接生成回答？
 *   本 MCP server 没有内置 LLM，"合成回答"由调用方（Claude/GPT 等）完成。
 *   工具负责"检索 + 组装"，调用方负责"理解 + 生成"，职责清晰、可独立测试。
 */

import { z } from 'zod';
import { ChunkRepository } from '../repositories/chunkRepository.js';
import { ContextAssembler } from '../services/contextAssembler.js';
import {
    CHUNK_TOP_K,
    CONTEXT_ADJACENT_RADIUS,
    CONTEXT_MAX_CHARS,
    CONTEXT_MAX_CHUNKS,
} from '../config/tuning.js';

export const queryDocsInput = z.object({
    /** 自然语言查询，将被向量化后用于语义检索 */
    query: z.string().min(1),
    /** 语义检索拉取的候选 chunk 数，最终受字符预算限制 */
    limit: z.number().int().min(1).max(50).optional().default(CHUNK_TOP_K),
    /**
     * 每个命中 chunk 向前后各扩展的邻块数。
     * 0 = 不扩展（纯向量检索结果）；1 = 各取一块（推荐）；2 = 各取两块（长文档）
     */
    adjacentRadius: z
        .number()
        .int()
        .min(0)
        .max(3)
        .optional()
        .default(CONTEXT_ADJACENT_RADIUS),
    /** 上下文总字符数预算，超出时截断末尾 chunk */
    maxChars: z.number().int().min(500).optional().default(CONTEXT_MAX_CHARS),
    /** 扩展后保留的最大 chunk 数量 */
    maxChunks: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .default(CONTEXT_MAX_CHUNKS),
    /** 仅检索指定文档路径下的 chunk（精确路径过滤） */
    path: z.string().optional(),
});

export type QueryDocsInput = z.infer<typeof queryDocsInput>;

export function createQueryDocsTool() {
    const repo = new ChunkRepository();
    const assembler = new ContextAssembler(repo);

    return {
        name: 'query_docs',
        description:
            '对文档知识库进行语义检索，返回与查询最相关的文档片段（已组装为可直接注入 prompt 的上下文文本）。\n' +
            '使用场景：\n' +
            '- 查找 QA 文档、架构说明、设计决策等非代码知识\n' +
            '- 需要引用具体文档原文回答时\n' +
            '- 回答后请基于返回的 contextText 中的原文进行陈述，不要凭空补充\n' +
            '注意：本工具检索文档 chunk，代码符号请使用 search_symbols / recommend_component。',
        inputSchema: queryDocsInput.shape,
        handler: async (input: QueryDocsInput) => {
            // ── 阶段1：语义检索 ─────────────────────────────────────────────
            const hits = await repo.searchSemantic(input.query, {
                limit: input.limit,
                path: input.path,
            });

            if (hits.length === 0) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify({
                                contextText: '',
                                sources: [],
                                hitCount: 0,
                                totalChunks: 0,
                                truncated: false,
                                message:
                                    '未找到相关文档片段，请尝试调整查询或确认文档已建立索引。',
                            }),
                        },
                    ],
                };
            }

            // ── 阶段2：邻块扩展 + 去重 + 预算截断 + 文本渲染 ───────────────
            const assembled = await assembler.assemble(hits, {
                maxChars: input.maxChars,
                adjacentRadius: input.adjacentRadius,
                maxChunks: input.maxChunks,
            });

            // sources 供调用方引用来源，避免 LLM 伪造引用。
            const sources = assembled.chunks.map((chunk) => ({
                path: chunk.path,
                title: chunk.title,
                chunkIndex: chunk.chunkIndex,
                chunkCount: chunk.chunkCount,
                similarity: chunk.similarity ?? null,
                summary: chunk.summary ?? null,
            }));

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify({
                            contextText: assembled.contextText,
                            sources,
                            hitCount: assembled.hitCount,
                            totalChunks: assembled.totalChunks,
                            truncated: assembled.truncated,
                        }),
                    },
                ],
            };
        },
    };
}
