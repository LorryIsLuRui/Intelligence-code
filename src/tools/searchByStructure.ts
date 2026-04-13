// 按结构字段检索（匹配 meta.props / meta.params / meta.properties / meta.hooks）
import { z } from 'zod';
import type { SymbolRepository } from '../repositories/symbolRepository.js';
import { rankSymbols } from '../services/ranking.js';

export const searchByStructureInput = z.object({
    fields: z.array(z.string().min(1)).min(1),
    type: z
        .enum(['component', 'function', 'hook', 'type', 'interface', 'class'])
        .optional(),
    category: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional().default(20),
    ranked: z.boolean().optional().default(true),
});

export function createSearchByStructureTool(repository: SymbolRepository) {
    return {
        name: 'search_by_structure',
        description:
            '通过结构化字段（如 props/params/properties/hooks）搜索代码块，适用于 API 形态的查询。',
        inputSchema: searchByStructureInput.shape,
        handler: async (input: z.infer<typeof searchByStructureInput>) => {
            const rows = await repository.searchByStructure(input.fields, {
                type: input.type,
                category: input.category,
                limit: input.limit,
            });
            const query = input.fields.join(' ');
            const resultRows = input.ranked
                ? rankSymbols(query, rows).map((item) => ({
                      id: item.symbol.id,
                      name: item.symbol.name,
                      type: item.symbol.type,
                      category: item.symbol.category,
                      path: item.symbol.path,
                      description: item.symbol.description,
                      usageCount: item.symbol.usageCount,
                      score: item.score,
                      reason: item.reason.summary,
                      reasonDetail: item.reason,
                      meta: item.symbol.meta,
                  }))
                : rows.map((r) => ({
                      id: r.id,
                      name: r.name,
                      type: r.type,
                      category: r.category,
                      path: r.path,
                      description: r.description,
                      usageCount: r.usageCount,
                      meta: r.meta,
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
