import { describe, expect, it } from 'vitest';
import { createSearchSymbolsTool } from '../src/tools/searchSymbols.ts';
import type { CodeSymbol } from '../src/types/symbol.ts';

function makeFunction(overrides: Partial<CodeSymbol> = {}): CodeSymbol {
    return {
        id: 157,
        name: 'getOffsetTop',
        type: 'function',
        category: 'components',
        path: 'formUtils/one-ui/Components/utils/dom.js',
        description: '获取元素相对于目标容器的位置',
        content: null,
        meta: {
            params: ['$p0', '$p1'],
            sideEffects: ['dom'],
        },
        usageCount: 0,
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

describe('search_symbols', () => {
    it('falls back to keyword search when semantic search returns no rows', async () => {
        const repository = {
            searchSemanticHits: async () => [],
            search: async () => [makeFunction()],
        } as any;

        const tool = createSearchSymbolsTool(repository);
        const result = await tool.handler({
            query: '获取元素相对于目标元素的位置 计算元素相对容器位置',
            type: 'function',
            ranked: true,
            semantic: true,
            limit: 5,
        });

        const rows = JSON.parse(result.content[0].text);
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe('getOffsetTop');
        expect(rows[0].type).toBe('function');
    });
});
