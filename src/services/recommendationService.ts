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

const NON_REUSABLE_PATH_SEGMENTS = [
    '__tests__',
    '__mocks__',
    '/test/',
    '/tests/',
    '/fixtures/',
    '/stories/',
    '/story/',
];

const DEMO_LIKE_PATH_SEGMENTS_STRICT = [
    '/one-ui-demo/',
    '/example/',
    '/examples/',
    '/demo/',
    '/demos/',
];

const DEMO_LIKE_PATH_SEGMENTS_SOFT = [
    '/one-ui-demo/',
    '/example/',
    '/examples/',
];

const NON_REUSABLE_PATH_PATTERNS = [
    '.test.',
    '.spec.',
    '.stories.',
    '.story.',
    '.mock.',
];

const NON_REUSABLE_NAME_TOKENS = ['mock', 'fixture', 'example', 'demo'];

const MIN_RECOMMENDATION_SCORE = {
    semantic: 0.5,
    keyword: 0.45,
} as const;

const MIN_SEMANTIC_TEXT_SCORE = 0.6;
const MIN_LITERAL_MATCH_SCORE = 0.18;

function isDemoLikePath(path: string, strict = false): boolean {
    const normalizedPath = path.toLowerCase();
    const segments = strict
        ? DEMO_LIKE_PATH_SEGMENTS_STRICT
        : DEMO_LIKE_PATH_SEGMENTS_SOFT;
    return segments.some((segment) => normalizedPath.includes(segment));
}

/**
 * 判断是否为可复用候选，过滤掉明显的测试/示例代码。虽然有可能误伤一些真实组件，但优先保证推荐结果的实用性和专业度。
 * @param symbol 要判断的代码符号
 * @returns boolean 是否为可复用候选
 */
export function isReusableCandidate(symbol: CodeSymbol): boolean {
    const path = symbol.path.toLowerCase();
    const name = symbol.name.toLowerCase();

    if (
        isDemoLikePath(path, true) ||
        NON_REUSABLE_PATH_SEGMENTS.some((segment) => path.includes(segment)) ||
        NON_REUSABLE_PATH_PATTERNS.some((pattern) => path.includes(pattern))
    ) {
        return false;
    }

    return !NON_REUSABLE_NAME_TOKENS.some(
        (token) => name === token || name.startsWith(token)
    );
}

/**
 * 判断推荐结果的props/hooks等结构字段是否满足查询要求，作为强相关推荐的加分项之一。虽然有可能遗漏一些未正确标注字段的结果，但优先保证推荐结果的相关性和准确性。
 * @param symbol 要判断的代码符号
 * @param requiredProps 必需的属性列表
 * @param requiredHooks 必需的钩子列表
 * @returns boolean 是否为强相关推荐结果
 */
function hasAllRequiredFields(
    symbol: CodeSymbol,
    requiredProps: string[],
    requiredHooks: string[]
): boolean {
    if (requiredProps.length === 0 && requiredHooks.length === 0) {
        return false;
    }

    const props = getMetaStrings(symbol, 'props').map(normalizeToken);
    const hooks = getMetaStrings(symbol, 'hooks').map(normalizeToken);

    return (
        requiredProps.every((field) => props.includes(normalizeToken(field))) &&
        requiredHooks.every((field) => hooks.includes(normalizeToken(field)))
    );
}

function extractLiteralTokens(query: string): string[] {
    const tokens = new Set<string>();
    const genericTokens = new Set([
        'component',
        'components',
        'hook',
        'hooks',
        'util',
        'utils',
        'function',
        'functions',
        'class',
        'classes',
        'type',
        'types',
    ]);
    const normalized = query.trim().toLowerCase();
    for (const match of normalized.matchAll(/[a-z0-9_]+/g)) {
        const token = match[0];
        if (token.length >= 3 && !genericTokens.has(token)) {
            tokens.add(token);
        }
    }
    return [...tokens];
}

// eg: query='useDebounceInput组件', symbol.name='useDebounceInput' => match; query='防抖组件', symbol.name='useDebounceInput' => match; query='input组件', symbol.name='useDebounceInput' => weak match
function hasStrongLiteralMatch(query: string, symbol: CodeSymbol): boolean {
    const normalizedQuery = query.trim().toLowerCase();
    const name = symbol.name.toLowerCase();
    const path = symbol.path.toLowerCase();
    const basename = path.split('/').pop() ?? '';

    if (
        normalizedQuery &&
        (name === normalizedQuery || path.includes(normalizedQuery))
    ) {
        return true;
    }

    const tokens = extractLiteralTokens(query);
    return tokens.some(
        (token) =>
            name === token || name.includes(token) || basename.includes(token)
    );
}

function isStrongEnoughRecommendation(
    item: ReturnType<typeof rankSemanticHits>[number],
    query: string,
    queriedBy: 'semantic' | 'keyword',
    requiredProps: string[],
    requiredHooks: string[]
): boolean {
    const hasRequiredFieldMatch = hasAllRequiredFields(
        item.symbol,
        requiredProps,
        requiredHooks
    );
    const hasLiteralMatch = hasStrongLiteralMatch(query, item.symbol);

    if (queriedBy === 'semantic') {
        return (
            (item.score >= MIN_RECOMMENDATION_SCORE.semantic &&
                (item.reason.textMatch.score >= MIN_SEMANTIC_TEXT_SCORE ||
                    hasRequiredFieldMatch)) ||
            (hasLiteralMatch && item.score >= MIN_LITERAL_MATCH_SCORE)
        );
    }

    return (
        item.score >= MIN_RECOMMENDATION_SCORE.keyword ||
        (hasRequiredFieldMatch && item.score >= 0.4)
    );
}

function computeRecommendationPriority(
    item: ReturnType<typeof rankSemanticHits>[number],
    query: string
): { score: number; reason: string } {
    let score = item.score;
    const notes: string[] = [];
    const path = item.symbol.path.toLowerCase();

    if (hasStrongLiteralMatch(query, item.symbol)) {
        score += 0.22;
        notes.push('名称或文件名命中查询');
    }

    if (isDemoLikePath(path)) {
        score -= 0.18;
        notes.push('示例工程路径降权');
    }

    return {
        score: Number(Math.max(0, score).toFixed(3)),
        reason:
            notes.length > 0
                ? `${item.reason.summary} + ${notes.join(' + ')}`
                : item.reason.summary,
    };
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

        const reusableCandidates = combined.filter(isReusableCandidate);
        if (reusableCandidates.length > 0) {
            console.error(
                '[code-intelligence-mcp] recommendComponent.reusableFilter before=%s after=%s removed=%s',
                String(combined.length),
                String(reusableCandidates.length),
                String(combined.length - reusableCandidates.length)
            );
            combined = reusableCandidates;
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
                      })),
                      input.query
                  )
                : rankSymbols(input.query, combined);

        const qualifiedRanked = ranked.filter((item) =>
            isStrongEnoughRecommendation(
                item,
                input.query,
                queriedBy,
                requiredProps,
                requiredHooks
            )
        );
        console.error(
            '[code-intelligence-mcp] recommendComponent.qualityGate before=%s after=%s queriedBy=%s',
            String(ranked.length),
            String(qualifiedRanked.length),
            queriedBy
        );

        const prioritizedRanked = qualifiedRanked
            .map((item) => {
                const adjusted = computeRecommendationPriority(
                    item,
                    input.query
                );
                return {
                    item,
                    adjustedScore: adjusted.score,
                    adjustedReason: adjusted.reason,
                };
            })
            .sort((a, b) => b.adjustedScore - a.adjustedScore);

        const candidates = prioritizedRanked.map((entry) =>
            toCandidate(
                entry.item.symbol,
                entry.adjustedScore,
                entry.adjustedReason,
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
