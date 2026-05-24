import { describe, expect, it } from 'vitest';
import { createSearchSymbolsTool } from '../src/tools/searchSymbols.ts';
import type { CodeSymbol } from '../src/types/symbol.ts';

function makeComponent(overrides: Partial<CodeSymbol> = {}): CodeSymbol {
    return {
        id: 1,
        name: 'Affix',
        type: 'component',
        category: 'layout',
        path: 'src/components/Affix.tsx',
        description: 'Keep content fixed at a target position while scrolling',
        content: null,
        meta: {
            props: ['offsetTop', 'offsetBottom', 'target'],
            sideEffects: ['dom'],
        },
        usageCount: 3,
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

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

    it('filters out mock and test-file symbols from semantic search results', async () => {
        const repository = {
            searchSemanticHits: async () => [
                {
                    symbol: makeComponent({
                        id: 10,
                        name: 'MockFormItem',
                        path: 'src/forms/linkage.test.js',
                        description: 'Mock form item used in linkage tests',
                        usageCount: 50,
                    }),
                    similarity: 0.95,
                },
                {
                    symbol: makeComponent(),
                    similarity: 0.72,
                },
            ],
            search: async () => [],
        } as any;

        const tool = createSearchSymbolsTool(repository);
        const result = await tool.handler({
            query: 'affix 固定定位',
            type: 'component',
            ranked: true,
            semantic: true,
            limit: 5,
        });

        const rows = JSON.parse(result.content[0].text);
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe('Affix');
    });
});
