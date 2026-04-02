import { z } from 'zod';
import type { SymbolRepository } from '../repositories/symbolRepository.js';

export const getSymbolDetailInput = z.object({
    name: z.string().min(1),
});

export function createGetSymbolDetailTool(repository: SymbolRepository) {
    return {
        name: 'get_symbol_detail',
        description: '按名称获取单个代码块的完整详情。',
        inputSchema: getSymbolDetailInput.shape,
        handler: async (input: z.infer<typeof getSymbolDetailInput>) => {
            const symbol = await repository.getByName(input.name);
            if (!symbol) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `未找到代码块：${input.name}`,
                        },
                    ],
                };
            }

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(symbol, null, 2),
                    },
                ],
            };
        },
    };
}
