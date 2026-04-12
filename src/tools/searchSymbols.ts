import { z } from 'zod';
import type { SymbolRepository } from '../repositories/symbolRepository.js';
import { rankSemanticHits, rankSymbols } from '../services/ranking.js';

export const searchSymbolsInput = z.object({
    query: z.string().min(1),
    type: z.enum(['component', 'util', 'selector', 'type']).optional(),
    ranked: z.boolean().optional().default(true),
    /** Phase 5：自然语言 / 描述句检索（需 EMBEDDING_SERVICE_URL + 索引已写入 embedding） */
    semantic: z.boolean().optional().default(false),
    limit: z.number().int().min(1).max(100).optional().default(20),
});
const THREADHOLD_SIMILARITY_FOR_FINAL = 0.6;
const TOP_K_FOR_FINAL_RESULTS = 20; // 结果上限,返回相似度高的，保证数据质量

export function createSearchSymbolsTool(repository: SymbolRepository) {
    return {
        name: 'search_symbols',
        description:
            '通过关键词和可选的类型搜索代码块。设置 semantic=true 可进行自然语言/意图式搜索（此功能需要 embedding 服务 + 已索引的向量）。',
        inputSchema: searchSymbolsInput.shape,
        handler: async (input: z.infer<typeof searchSymbolsInput>) => {
            if (input.semantic) {
                const hits = await repository.searchSemanticHits(input.query, {
                    type: input.type,
                    limit: input.limit,
                });
                const simById = new Map(
                    hits.map((h) => [h.symbol.id, h.similarity])
                );
                const resultRows = input.ranked
                    ? rankSemanticHits(hits)
                          .map((item) => ({
                              id: item.symbol.id,
                              name: item.symbol.name,
                              type: item.symbol.type,
                              path: item.symbol.path,
                              description: item.symbol.description,
                              usageCount: item.symbol.usageCount,
                              score: item.score,
                              reason: item.reason.summary,
                              reasonDetail: item.reason,
                              semanticSimilarity: Number(
                                  (simById.get(item.symbol.id) ?? 0).toFixed(4)
                              ),
                          }))
                          .filter(
                              (x) =>
                                  x.semanticSimilarity >=
                                  THREADHOLD_SIMILARITY_FOR_FINAL
                          ) // 阈值过滤，去掉明显不相关的结果
                          .slice(0, TOP_K_FOR_FINAL_RESULTS)
                    : hits.map((h) => ({
                          id: h.symbol.id,
                          name: h.symbol.name,
                          type: h.symbol.type,
                          path: h.symbol.path,
                          description: h.symbol.description,
                          usageCount: h.symbol.usageCount,
                          semanticSimilarity: Number(h.similarity.toFixed(4)),
                      }));
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(resultRows, null, 2),
                        },
                    ],
                };
            }

            const rows = await repository.search(input.query, input.type);
            const resultRows = input.ranked
                ? rankSymbols(input.query, rows)
                      .map((item) => ({
                          id: item.symbol.id,
                          name: item.symbol.name,
                          type: item.symbol.type,
                          path: item.symbol.path,
                          description: item.symbol.description,
                          usageCount: item.symbol.usageCount,
                          score: item.score,
                          reason: item.reason.summary,
                          reasonDetail: item.reason,
                      }))
                      .filter((x) => x.score >= THREADHOLD_SIMILARITY_FOR_FINAL) // 阈值过滤，去掉明显不相关的结果
                      .slice(0, TOP_K_FOR_FINAL_RESULTS)
                : rows.map((r) => ({
                      id: r.id,
                      name: r.name,
                      type: r.type,
                      path: r.path,
                      description: r.description,
                      usageCount: r.usageCount,
                  }));
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(resultRows, null, 2),
                    },
                ],
            };
        },
    };
}
