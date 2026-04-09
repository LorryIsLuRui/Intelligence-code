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
            '当开发者采纳了某个推荐代码块时，调用此工具记录。usage_count 会 +1，用于后续排序优化。',
        inputSchema: incUsageInput.shape,
        handler: async (input: z.infer<typeof incUsageInput>) => {
            const success = await repository.incUsage(input.symbolId);
            if (!success) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(
                                { error: '未找到该代码块', symbolId: input.symbolId },
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
                            { ok: true, symbolId: input.symbolId, message: 'usage_count 已 +1' },
                            null,
                            2
                        ),
                    },
                ],
            };
        },
    };
}