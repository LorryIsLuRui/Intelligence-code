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
            '按代码块的结构字段（props/params/hooks）检索，适合已知接口形态时使用。\n' +
            '示例：需要一个接受 value、onChange、error 三个 prop 的输入组件 → fields: ["value", "onChange", "error"], type: "component"\n' +
            '与 search_symbols 配合：先语义检索候选，再用本工具做 API 结构过滤以精确匹配。\n' +
            '约束：当用户是在问“有没有可复用组件/帮我找组件”时，默认不要调用本工具；仅在用户明确要求二次验证时使用。',
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
