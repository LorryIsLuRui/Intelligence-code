import { z } from 'zod';
import type { SymbolRepository } from '../repositories/symbolRepository.js';

export const getSymbolDetailInput = z.object({
    name: z.string().min(1),
});

export function createGetSymbolDetailTool(repository: SymbolRepository) {
    return {
        name: 'get_symbol_detail',
        description:
            '获取单个代码块的完整详情（含源码、参数类型、调用关系、副作用）。\n' +
            '仅在以下情况调用：search_symbols 返回的摘要信息不足以判断是否适用（如签名模糊、副作用不明确）。\n' +
            '通常对 top 1-3 候选调用，不要对所有结果批量调用。',
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
