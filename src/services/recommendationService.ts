import type { SymbolRepository } from '../repositories/symbolRepository.js';
import { rankSemanticHits, rankSymbols } from './ranking.js';
import type { CodeSymbol, SymbolType } from '../types/symbol.js';

export interface RecommendComponentInput {
    query: string;
    requiredProps?: string[];
    requiredHooks?: string[];
    category?: string;
    semantic?: boolean;
    limit?: number;
}

export interface RecommendedCandidate {
    id: number;
    name: string;
    type: CodeSymbol['type'];
    path: string;
    description: string | null;
    usageCount: number;
    category: string | null;
    score: number;
    reason: string;
    matchedProps: string[];
    matchedHooks: string[];
    callers: Array<{ name: string; path: string }>;
    sideEffects: string[];
}

export interface RecommendComponentResult {
    recommended: RecommendedCandidate | null;
    alternatives: RecommendedCandidate[];
    queriedBy: 'semantic' | 'keyword';
    structureFilter: {
        requiredProps: string[];
        requiredHooks: string[];
    };
    message: string;
}

function uniqueStrings(values: string[] = []): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeToken(value: string): string {
    return value.trim().toLowerCase();
}

type SearchTypeHint = {
    keywords: string[];
    types: SymbolType[];
};

const CATEGORY_TYPE_HINTS: SearchTypeHint[] = [
    { keywords: ['util'], types: ['function'] },
    { keywords: ['hook'], types: ['hook'] },
    { keywords: ['type'], types: ['type', 'interface'] },
    { keywords: ['class'], types: ['class'] },
    { keywords: ['component'], types: ['component'] },
];

const QUERY_TYPE_HINTS: SearchTypeHint[] = [
    {
        keywords: [' util', 'util ', 'helper', '函数', '方法', '计算', '获取'],
        types: ['function'],
    },
    { keywords: ['hook', ' use'], types: ['hook'] },
];

function resolveTypesByHints(
    source: string,
    hints: SearchTypeHint[]
): SymbolType[] {
    for (const hint of hints) {
        if (hint.keywords.some((keyword) => source.includes(keyword))) {
            return [...new Set(hint.types)];
        }
    }
    return [];
}

function inferSearchTypes(input: RecommendComponentInput): SymbolType[] {
    const query = input.query.toLowerCase();
    const category = (input.category ?? '').toLowerCase();

    const categoryTypes = resolveTypesByHints(category, CATEGORY_TYPE_HINTS);
    if (categoryTypes.length > 0) return categoryTypes;

    const queryTypes = resolveTypesByHints(query, QUERY_TYPE_HINTS);
    if (queryTypes.length > 0) return queryTypes;

    return ['component'];
}

function getMetaStrings(symbol: CodeSymbol, key: string): string[] {
    const value = symbol.meta?.[key];
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
}

function getCallers(symbol: CodeSymbol): Array<{ name: string; path: string }> {
    const value = symbol.meta?.callers;
    if (!Array.isArray(value)) return [];
    return value.filter(
        (item): item is { name: string; path: string } =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as { name?: unknown }).name === 'string' &&
            typeof (item as { path?: unknown }).path === 'string'
    );
}

function toCandidate(
    symbol: CodeSymbol,
    score: number,
    reason: string,
    requiredProps: string[],
    requiredHooks: string[]
): RecommendedCandidate {
    const props = getMetaStrings(symbol, 'props');
    const hooks = getMetaStrings(symbol, 'hooks');
    const sideEffects = getMetaStrings(symbol, 'sideEffects');

    return {
        id: symbol.id,
        name: symbol.name,
        type: symbol.type,
        path: symbol.path,
        description: symbol.description,
        usageCount: symbol.usageCount,
        category: symbol.category,
        score: Number(score.toFixed(3)),
        reason,
        matchedProps: requiredProps.filter((field) =>
            props.map(normalizeToken).includes(normalizeToken(field))
        ),
        matchedHooks: requiredHooks.filter((field) =>
            hooks.map(normalizeToken).includes(normalizeToken(field))
        ),
        callers: getCallers(symbol),
        sideEffects,
    };
}

function mergeCandidates(symbols: CodeSymbol[]): CodeSymbol[] {
    const seen = new Set<number>();
    const merged: CodeSymbol[] = [];
    for (const symbol of symbols) {
        if (seen.has(symbol.id)) continue;
        seen.add(symbol.id);
        merged.push(symbol);
    }
    return merged;
}

export class RecommendationService {
    constructor(private readonly repository: SymbolRepository) {}

    async recommendComponent(
        input: RecommendComponentInput
    ): Promise<RecommendComponentResult> {
        console.error(
            '[code-intelligence-mcp] recommendComponent.start query=%s category=%s semantic=%s limit=%s requiredProps=%s requiredHooks=%s',
            input.query,
            input.category ?? '',
            String(input.semantic ?? true),
            String(input.limit ?? 5),
            JSON.stringify(input.requiredProps ?? []),
            JSON.stringify(input.requiredHooks ?? [])
        );

        const requiredProps = uniqueStrings(input.requiredProps);
        const requiredHooks = uniqueStrings(input.requiredHooks);
        const structureFields = uniqueStrings([
            ...requiredProps,
            ...requiredHooks,
        ]);
        const searchTypes = inferSearchTypes(input);
        const preferSemantic = input.semantic ?? true;
        const limit = input.limit ?? 5;
        let queriedBy: 'semantic' | 'keyword' = preferSemantic
            ? 'semantic'
            : 'keyword';
        let searchResults: Array<{ symbol: CodeSymbol; similarity: number }>;

        console.error(
            '[code-intelligence-mcp] recommendComponent.searchTypes types=%s',
            JSON.stringify(searchTypes)
        );

        if (preferSemantic) {
            try {
                const semanticGroups = await Promise.all(
                    searchTypes.map((type) =>
                        this.repository.searchSemanticHits(input.query, {
                            type,
                            limit: Math.max(limit * 4, 12),
                        })
                    )
                );
                searchResults = semanticGroups.flat();
                console.error(
                    '[code-intelligence-mcp] recommendComponent.semanticHits count=%s top=%s',
                    String(searchResults.length),
                    JSON.stringify(
                        searchResults.slice(0, 3).map((item) => ({
                            id: item.symbol.id,
                            name: item.symbol.name,
                            path: item.symbol.path,
                            similarity: Number(item.similarity.toFixed(4)),
                        }))
                    )
                );
            } catch {
                queriedBy = 'keyword';
                const keywordGroups = await Promise.all(
                    searchTypes.map((type) =>
                        this.repository.search(input.query, type)
                    )
                );
                searchResults = keywordGroups
                    .flat()
                    .map((symbol) => ({ symbol, similarity: 0 }));
                console.error(
                    '[code-intelligence-mcp] recommendComponent.semanticFailed fallback=keyword count=%s top=%s',
                    String(searchResults.length),
                    JSON.stringify(
                        searchResults.slice(0, 3).map((item) => ({
                            id: item.symbol.id,
                            name: item.symbol.name,
                            path: item.symbol.path,
                        }))
                    )
                );
            }
        } else {
            const keywordGroups = await Promise.all(
                searchTypes.map((type) =>
                    this.repository.search(input.query, type)
                )
            );
            searchResults = keywordGroups
                .flat()
                .map((symbol) => ({ symbol, similarity: 0 }));
            console.error(
                '[code-intelligence-mcp] recommendComponent.keywordOnly count=%s top=%s',
                String(searchResults.length),
                JSON.stringify(
                    searchResults.slice(0, 3).map((item) => ({
                        id: item.symbol.id,
                        name: item.symbol.name,
                        path: item.symbol.path,
                    }))
                )
            );
        }

        const structureResults = structureFields.length
            ? (
                  await Promise.all(
                      searchTypes.map((type) =>
                          this.repository.searchByStructure(structureFields, {
                              type,
                              limit: Math.max(limit * 4, 12),
                          })
                      )
                  )
              ).flat()
            : [];
        console.error(
            '[code-intelligence-mcp] recommendComponent.structureHits fields=%s count=%s top=%s',
            JSON.stringify(structureFields),
            String(structureResults.length),
            JSON.stringify(
                structureResults.slice(0, 3).map((symbol) => ({
                    id: symbol.id,
                    name: symbol.name,
                    path: symbol.path,
                }))
            )
        );
        // 合并逻辑：先合并语义搜索（或关键词模糊搜索）和结构搜索结果去重
        const mergedBeforeCategory = mergeCandidates([
            ...structureResults,
            ...searchResults.map((item) => item.symbol),
        ]);
        // 再按 category 过滤（如果有 category 限制）
        let combined = mergedBeforeCategory.filter((symbol) =>
            input.category
                ? (symbol.category ?? '')
                      .toLowerCase()
                      .includes(input.category.toLowerCase())
                : true
        );

        // LLM 可能把 "input" 之类词误当作 category，导致误筛空；若筛空则回退为不按 category 过滤。
        if (
            combined.length === 0 &&
            input.category &&
            mergedBeforeCategory.length
        ) {
            console.error(
                '[code-intelligence-mcp] recommendComponent.categoryFallback category=%s merged=%s -> useUnfiltered',
                input.category,
                String(mergedBeforeCategory.length)
            );
            combined = mergedBeforeCategory;
        }
        console.error(
            '[code-intelligence-mcp] recommendComponent.combine merged=%s afterCategory=%s top=%s',
            String(mergedBeforeCategory.length),
            String(combined.length),
            JSON.stringify(
                combined.slice(0, 3).map((symbol) => ({
                    id: symbol.id,
                    name: symbol.name,
                    path: symbol.path,
                    category: symbol.category,
                }))
            )
        );

        if (combined.length === 0) {
            console.error(
                '[code-intelligence-mcp] recommendComponent.emptyResult query=%s queriedBy=%s requiredProps=%s requiredHooks=%s',
                input.query,
                queriedBy,
                JSON.stringify(requiredProps),
                JSON.stringify(requiredHooks)
            );
            return {
                recommended: null,
                alternatives: [],
                queriedBy,
                structureFilter: {
                    requiredProps,
                    requiredHooks,
                },
                message: '未找到符合条件的可复用组件。',
            };
        }
        // 最后排序并切分首选/备选
        const ranked =
            queriedBy === 'semantic'
                ? rankSemanticHits(
                      combined.map((symbol) => ({
                          symbol,
                          similarity:
                              searchResults.find(
                                  (item) => item.symbol.id === symbol.id
                              )?.similarity ?? 0.55,
                      }))
                  )
                : rankSymbols(input.query, combined);

        const candidates = ranked.map((item) =>
            toCandidate(
                item.symbol,
                item.score,
                item.reason.summary,
                requiredProps,
                requiredHooks
            )
        );
        console.error(
            '[code-intelligence-mcp] recommendComponent.ranked count=%s top=%s',
            String(candidates.length),
            JSON.stringify(
                candidates.slice(0, 3).map((candidate) => ({
                    id: candidate.id,
                    name: candidate.name,
                    path: candidate.path,
                    score: candidate.score,
                    matchedProps: candidate.matchedProps,
                    matchedHooks: candidate.matchedHooks,
                }))
            )
        );

        return {
            recommended: candidates[0] ?? null,
            alternatives: candidates.slice(1, limit),
            queriedBy,
            structureFilter: {
                requiredProps,
                requiredHooks,
            },
            message:
                candidates.length > 0
                    ? '已找到可复用组件候选，首选已按综合匹配度排序。'
                    : '未找到符合条件的可复用组件。',
        };
    }
}
