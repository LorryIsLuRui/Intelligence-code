import { describe, expect, it } from 'vitest';
import { RecommendationService } from '../src/services/recommendationService.ts';
import type { CodeSymbol } from '../src/types/symbol.ts';

function makeComponent(overrides: Partial<CodeSymbol> = {}): CodeSymbol {
    return {
        id: 1,
        name: 'BaseInput',
        type: 'component',
        category: 'form',
        path: 'src/components/BaseInput.tsx',
        description: 'Reusable input component',
        content: null,
        meta: {
            props: ['value', 'onChange', 'placeholder'],
            hooks: ['useId'],
            sideEffects: [],
            callers: [{ name: 'FormPage', path: 'src/pages/FormPage.tsx' }],
        },
        usageCount: 10,
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

function makeFunction(overrides: Partial<CodeSymbol> = {}): CodeSymbol {
    return {
        id: 10,
        name: 'getOffsetTop',
        type: 'function',
        category: 'components',
        path: 'formUtils/one-ui/Components/utils/dom.js',
        description: '获取元素相对于目标容器的位置',
        content: null,
        meta: {
            params: ['$p0', '$p1'],
            sideEffects: ['dom'],
            callers: [],
        },
        usageCount: 0,
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

describe('RecommendationService', () => {
    it('returns the best matched component and alternatives', async () => {
        const repository = {
            searchSemanticHits: async () => [
                {
                    symbol: makeComponent({ id: 1, name: 'BaseInput' }),
                    similarity: 0.91,
                },
                {
                    symbol: makeComponent({
                        id: 2,
                        name: 'TextField',
                        usageCount: 6,
                    }),
                    similarity: 0.75,
                },
            ],
            search: async () => [],
            searchByStructure: async () => [
                makeComponent({
                    id: 2,
                    name: 'TextField',
                    meta: {
                        props: ['value', 'onChange', 'error'],
                        hooks: [],
                        sideEffects: [],
                    },
                }),
            ],
        } as any;

        const service = new RecommendationService(repository);
        const result = await service.recommendComponent({
            query: 'input component',
            requiredProps: ['onChange'],
        });

        expect(result.recommended?.name).toBe('BaseInput');
        expect(result.recommended?.matchedProps).toContain('onChange');
        expect(result.alternatives.map((item) => item.name)).toContain(
            'TextField'
        );
        expect(result.queriedBy).toBe('semantic');
    });

    it('falls back to keyword mode when semantic search fails', async () => {
        const repository = {
            searchSemanticHits: async () => {
                throw new Error('embedding unavailable');
            },
            search: async () => [
                makeComponent({ id: 3, name: 'FallbackInput', usageCount: 4 }),
            ],
            searchByStructure: async () => [],
        } as any;

        const service = new RecommendationService(repository);
        const result = await service.recommendComponent({
            query: 'input component',
            requiredProps: ['onChange'],
        });

        expect(result.queriedBy).toBe('keyword');
        expect(result.recommended?.name).toBe('FallbackInput');
    });

    it('uses function search for util queries', async () => {
        const semanticTypes: string[] = [];
        const structureTypes: string[] = [];
        const repository = {
            searchSemanticHits: async (
                _query: string,
                opts?: { type?: string }
            ) => {
                semanticTypes.push(opts?.type ?? '');
                return opts?.type === 'function'
                    ? [
                          {
                              symbol: makeFunction(),
                              similarity: 0.88,
                          },
                      ]
                    : [];
            },
            search: async () => [],
            searchByStructure: async (
                _fields: string[],
                opts?: { type?: string }
            ) => {
                structureTypes.push(opts?.type ?? '');
                return [];
            },
        } as any;

        const service = new RecommendationService(repository);
        const result = await service.recommendComponent({
            query: '计算元素相对于目标元素的位置',
            category: 'util',
        });

        expect(semanticTypes).toEqual(['function']);
        expect(structureTypes).toEqual([]);
        expect(result.recommended?.name).toBe('getOffsetTop');
        expect(result.recommended?.type).toBe('function');
    });
});
