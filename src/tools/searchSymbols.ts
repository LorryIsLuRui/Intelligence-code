import { z } from 'zod';
import type { SymbolRepository } from '../repositories/symbolRepository.js';
import { rankSemanticHits, rankSymbols } from '../services/ranking.js';
import { isReusableCandidate } from '../services/recommendationService.js';

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
const SCORE_THRESHOLD_FOR_FINAL = 0.45; // 综合排序分阈值（语义相似度占50%权重，原始0.5相似度 ≈ 综合0.35起）
const TOP_K_FOR_FINAL_RESULTS = 20; // 结果上限,返回相似度高的，保证数据质量

function toRankedResult(item: ReturnType<typeof rankSymbols>[number]) {
    return {
        id: item.symbol.id,
        name: item.symbol.name,
        type: item.symbol.type,
        path: item.symbol.path,
        description: item.symbol.description,
        usageCount: item.symbol.usageCount,
        score: item.score,
        reason: item.reason.summary,
        reasonDetail: item.reason,
    };
}

function filterReusableSymbols<
    T extends { symbol: { path: string; name: string } },
>(items: T[]): T[] {
    return items.filter((item) => isReusableCandidate(item.symbol as any));
}

export function createSearchSymbolsTool(repository: SymbolRepository) {
    return {
        name: 'search_symbols',
        description:
            '【降级链第二步，非首选工具】搜索项目中已有的可复用代码块（函数、组件、Hook、类型等）。\n' +
            '⚠️ 调用顺序约束：对于"帮我找 X 组件/util/函数"类问题，第一步必须是 recommend_component，不得跳过直接调用本工具。\n' +
            '本工具仅在 recommend_component 返回 null（无推荐）后才允许调用，作为第二级降级检索。\n' +
            '- 有明确名称时（如 "useDebounce"）：semantic=false（默认），直接关键词检索\n' +
            '- 描述功能意图时（如 "防抖"、"处理表单提交"）：semantic=true，进行语义检索\n' +
            '- 不确定 type 时省略该参数\n' +
            '- 本工具返回结果后，必须立即按固定模板输出，停止所有后续工具调用。\n' +
            '- 本工具返回空结果后，输出无结果模板，完全停止，禁止 grep/read file/文件系统兜底。',
        inputSchema: searchSymbolsInput.shape,
        handler: async (input: z.infer<typeof searchSymbolsInput>) => {
            if (input.semantic) {
                const hits = await repository.searchSemanticHits(input.query, {
                    type: input.type,
                    limit: input.limit,
                });
                const reusableHits = filterReusableSymbols(hits);

                if (reusableHits.length === 0) {
                    const keywordRows = (
                        await repository.search(input.query, input.type)
                    ).filter((row) => isReusableCandidate(row));
                    const fallbackRows = input.ranked
                        ? rankSymbols(input.query, keywordRows)
                              .map(toRankedResult)
                              .filter(
                                  (x) => x.score >= SCORE_THRESHOLD_FOR_FINAL
                              )
                              .slice(0, TOP_K_FOR_FINAL_RESULTS)
                        : keywordRows.map((r) => ({
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
                                text: JSON.stringify(fallbackRows, null, 2),
                            },
                        ],
                    };
                }

                const simById = new Map(
                    reusableHits.map((h) => [h.symbol.id, h.similarity])
                );
                const resultRows = input.ranked
                    ? rankSemanticHits(reusableHits, input.query)
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
                          .filter((x) => x.score >= SCORE_THRESHOLD_FOR_FINAL) // 基于综合排序分过滤，保留 usage/recency 高的结果
                          .slice(0, TOP_K_FOR_FINAL_RESULTS)
                    : reusableHits.map((h) => ({
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

            const rows = (
                await repository.search(input.query, input.type)
            ).filter((row) => isReusableCandidate(row));
            const resultRows = input.ranked
                ? rankSymbols(input.query, rows)
                      .map(toRankedResult)
                      .filter((x) => x.score >= SCORE_THRESHOLD_FOR_FINAL) // 基于综合排序分过滤
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
