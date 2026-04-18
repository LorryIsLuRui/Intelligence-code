import { z } from 'zod';
import type { SymbolRepository } from '../repositories/symbolRepository.js';

export const incUsageInput = z.object({
    /** 要增加使用计数的代码块 ID（从搜索结果中获取） */
    symbolId: z.number().int().positive(),
});

export function createIncUsageTool(repository: SymbolRepository) {
    return {
        name: 'inc_usage',
        description:
            '在用户明确确认"采纳推荐"后调用，记录复用行为用于排序优化（usage_count +1）。\n' +
            '注意：仅在用户主动确认采纳时调用，不要在推荐后自动调用。\n' +
            'symbolId 从 search_symbols 或 search_by_structure 返回结果的 id 字段获取。',
        inputSchema: incUsageInput.shape,
        handler: async (input: z.infer<typeof incUsageInput>) => {
            const success = await repository.incUsage(input.symbolId);
            if (!success) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(
                                {
                                    error: '未找到该代码块',
                                    symbolId: input.symbolId,
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            }

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(
                            {
                                ok: true,
                                symbolId: input.symbolId,
                                message: 'usage_count 已 +1',
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        },
    };
}
