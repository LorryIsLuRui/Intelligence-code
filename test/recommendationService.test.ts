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

    it('filters out mock and test-file components for reusable component queries', async () => {
        const repository = {
            searchSemanticHits: async () => [
                {
                    symbol: makeComponent({
                        id: 20,
                        name: 'MockFormItem',
                        path: 'src/forms/linkage.test.js',
                        description: 'Mock form item used in linkage tests',
                        usageCount: 30,
                    }),
                    similarity: 0.95,
                },
                {
                    symbol: makeComponent({
                        id: 21,
                        name: 'Affix',
                        path: 'src/components/Affix.tsx',
                        description:
                            'Keep content fixed at a target position while scrolling',
                        usageCount: 4,
                        meta: {
                            props: ['offsetTop', 'offsetBottom', 'target'],
                            hooks: [],
                            sideEffects: ['dom'],
                            callers: [
                                {
                                    name: 'PageHeader',
                                    path: 'src/pages/PageHeader.tsx',
                                },
                            ],
                        },
                    }),
                    similarity: 0.72,
                },
            ],
            search: async () => [],
            searchByStructure: async () => [],
        } as any;

        const service = new RecommendationService(repository);
        const result = await service.recommendComponent({
            query: '帮我找一个affix组件，把内容固定在特定位置',
            limit: 5,
        });

        expect(result.recommended?.name).toBe('Affix');
        expect(result.alternatives.map((item) => item.name)).not.toContain(
            'MockFormItem'
        );
    });

    it('returns no recommendation when only low-relevance semantic matches remain', async () => {
        const repository = {
            searchSemanticHits: async () => [
                {
                    symbol: makeComponent({
                        id: 30,
                        name: 'PageLayout',
                        path: 'src/components/PageLayout.tsx',
                        description: 'Reusable page layout container',
                        usageCount: 100,
                    }),
                    similarity: 0.48,
                },
            ],
            search: async () => [],
            searchByStructure: async () => [],
        } as any;

        const service = new RecommendationService(repository);
        const result = await service.recommendComponent({
            query: '帮我找一个affix组件，把内容固定在特定位置',
            limit: 5,
        });

        expect(result.recommended).toBeNull();
        expect(result.alternatives).toEqual([]);
    });

    it('keeps explicit name hit candidates for semantic queries', async () => {
        const repository = {
            searchSemanticHits: async () => [
                {
                    symbol: makeComponent({
                        id: 40,
                        name: 'Affix',
                        path: 'formUtils/one-ui/Components/Affix/Affix.jsx',
                        description: 'Affix 固钉组件 将页面元素钉在可视范围',
                        usageCount: 0,
                    }),
                    similarity: 0.32,
                },
            ],
            search: async () => [],
            searchByStructure: async () => [],
        } as any;

        const service = new RecommendationService(repository);
        const result = await service.recommendComponent({
            query: '帮我找一个affix组件，把内容固定在特定位置',
            limit: 5,
        });

        expect(result.recommended?.name).toBe('Affix');
    });

    it('prioritizes explicit Affix hit over high-usage demo candidates', async () => {
        const repository = {
            searchSemanticHits: async () => [
                {
                    symbol: makeComponent({
                        id: 148,
                        name: 'Affix',
                        path: 'formUtils/one-ui/Components/Affix/Affix.jsx',
                        description: 'Affix 固钉组件 将页面元素钉在可视范围',
                        usageCount: 0,
                    }),
                    similarity: 0.2887,
                },
                {
                    symbol: makeComponent({
                        id: 165,
                        name: 'formReducer',
                        path: 'formUtils/one-ui/one-ui-demo/src/pages/ComplexForm.jsx',
                        usageCount: 120,
                    }),
                    similarity: 0.2003,
                },
            ],
            search: async () => [],
            searchByStructure: async () => [],
        } as any;

        const service = new RecommendationService(repository);
        const result = await service.recommendComponent({
            query: '帮我找一个affix组件，把内容固定在特定位置',
            limit: 5,
        });

        expect(result.recommended?.id).toBe(148);
    });
});
