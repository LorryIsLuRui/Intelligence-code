import { z } from 'zod';
import type { SymbolRepository } from '../repositories/symbolRepository.js';
import { rankSemanticHits, rankSymbols } from '../services/ranking.js';

export const searchSymbolsInput = z.object({
    query: z.string().min(1),
    type: z
        .enum(['component', 'function', 'hook', 'type', 'interface', 'class'])
        .optional(),
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
            '搜索项目中已有的可复用代码块（函数、组件、Hook、类型等）。在生成新代码之前必须先调用本工具，确认是否已有实现。\n' +
            '- 有明确名称时（如 "useDebounce"）：semantic=false（默认），直接关键词检索\n' +
            '- 描述功能意图时（如 "防抖"、"处理表单提交"）：semantic=true，进行语义检索（需 embedding 服务已就绪）\n' +
            '- 不确定 type 时省略该参数，不要猜测\n' +
            '- 返回结果含 semanticSimilarity 字段：>0.85 高置信度可直接推荐，0.6-0.85 需结合 description 判断，<0.6 说明可能无合适实现',
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
