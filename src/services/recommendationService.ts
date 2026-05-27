import type { SymbolRepository } from '../repositories/symbolRepository.js';
/**
 * ──────────────────────────────────────────────────────────────────────────────
 * [Agent 闭环流程总览]
 *
 * recommendComponent (核心 agent 主循环)
 *
 * 1. 解析输入，生成 query 变体（query rewrite，多轮尝试）
 * 2. 对每个 query 变体依次尝试：
 *    2.1. 搜索候选（优先语义，异常时回退关键词）
 *    2.2. 结构字段补充搜索（props/hooks）
 *    2.3. 合并去重、按 category 过滤、过滤不可复用项
 *    2.4. 排序、Top-K 详情补查（enrich）
 *    2.5. 质量门控（quality gate，必须命中 requiredProps/hooks 或高分）
 *    2.6. 优先级调整（如名称/路径命中加分、demo 路径降权）
 *    2.7. 命中则立即返回推荐结果，记录 debug trace
 *    2.8. 未命中则进入下一 query 变体（自动重试）
 * 3. 所有变体均未命中则返回无结果，debug trace 记录所有尝试
 *
 * 关键特性：
 * - query rewrite + retry（自动多轮尝试）
 * - 结构/语义/关键词多路融合
 * - Top-K 详情补查
 * - 质量门控与优先级调整
 * - 全流程 debug trace（可用于 agent 反思/可观测性）
 *
 * 总结：
 * “实现了一个单 agent 闭环推荐系统，支持 query 自动重写与多轮重试，融合语义/结构/关键词多路检索，Top-K 详情补查，质量门控与优先级调整，并输出全流程 debug trace，便于 agent 反思和可观测性。”
 * ──────────────────────────────────────────────────────────────────────────────
 */
import { rankSemanticHits, rankSymbols } from './ranking.js';
import type { CodeSymbol, SymbolType } from '../types/symbol.js';
import {
    DEMO_PATH_PRIORITY_PENALTY,
    INDEX_FILE_PRIORITY_BOOST,
    LITERAL_MATCH_PRIORITY_BOOST,
    MIN_LITERAL_MATCH_SCORE,
    MIN_RECOMMENDATION_SCORE,
    MIN_SEMANTIC_TEXT_MATCH_SCORE,
    REQUIRED_FIELD_FALLBACK_MIN_SCORE,
    SAME_DIR_INDEX_EXISTS_PENALTY,
} from '../config/tuning.js';
import { NOISE_PATTERNS, buildSynonymVariant } from '../config/queryRewrite.js';
import type { EvalTrace } from '../types/evalTrace.js';

/** 跳过原因标识 */
const SKIPPED_REASON = {
    NO_COMBINED: 'no_combined' as const,
    NO_QUALIFIED: 'no_qualified' as const,
};

/** 查询方式标识 */
const QUERIED_BY = {
    SEMANTIC: 'semantic' as const,
    KEYWORD: 'keyword' as const,
};

/** 回退原因标识 */
const FALLBACK_REASON = {
    SEMANTIC_ERROR: 'semantic_error_fallback_keyword' as const,
};

/** 推荐结果文案 */
const RECOMMENDATION_MESSAGE = {
    FOUND: '已找到可复用组件候选，首选已按综合匹配度排序。',
    NOT_FOUND: '未找到符合条件的可复用组件。',
};

/** 详情补查的 top-k 条数 */
const ENRICH_TOP_K = 3;
/** 最多取查询变体数量（原始 + 清洗 + 同义词扩展） */
const MAX_QUERY_VARIANTS = 3;
/** 结构/语义搜索 limit 倍数 */
const STRUCTURE_LIMIT_MULTIPLIER = 4;
/** 结构/语义搜索 limit 最小值 */
const STRUCTURE_LIMIT_MIN = 12;
/** 关键词搜索命中时的默认相似度补值 */
const DEFAULT_KEYWORD_SIMILARITY = 0.55;
// ──────────────────────────────────────────────────────────────────────────────

export interface RecommendComponentInput {
    query: string;
    requiredProps?: string[];
    requiredHooks?: string[];
    category?: string;
    semantic?: boolean;
    limit?: number;
    evalMode?: boolean;
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
    debug: RecommendationDebug;
    evalTrace?: EvalTrace;
}

export interface RecommendationAttempt {
    query: string;
    queriedBy: 'semantic' | 'keyword';
    searchCount: number;
    structureCount: number;
    combinedCount: number;
    qualifiedCount: number;
    detailEnrichedCount: number;
    skippedReason?: 'no_combined' | 'no_qualified';
}

export interface RecommendationDebug {
    attempts: RecommendationAttempt[];
    selectedQuery: string | null;
    retryUsed: boolean;
    fallbackReason: 'semantic_error_fallback_keyword' | null;
}

function uniqueStrings(values: string[] = []): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/**
 * 对原始查询进行清洗和变体生成：
 * 1. 噪音词清洗（去掉口语化前缀、无意义词）
 * 2. 同义词扩展（中英互转、别名替换）
 * 生成最多 MAX_QUERY_VARIANTS 个去重变体，按从精确到宽泛排序。
 */
function buildQueryVariants(rawQuery: string): string[] {
    const base = rawQuery.trim();
    if (!base) return [];

    // Step 1: 噪音词清洗
    let cleaned = base;
    for (const pattern of NOISE_PATTERNS) {
        cleaned = cleaned.replace(pattern, ' ');
    }
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    if (!cleaned) cleaned = base;

    // Step 2: 同义词扩展（基于清洗后的 query，减少噪音干扰匹配）
    const synonymVariant = buildSynonymVariant(cleaned);

    // 候选：原始 → 清洗后（若不同）→ 同义词扩展（若不同）
    const candidates = [
        base,
        cleaned,
        ...(synonymVariant ? [synonymVariant] : []),
    ];
    return uniqueStrings(candidates);
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

function isDemoLikePath(path: string, strict = false): boolean {
    const normalizedPath = path.toLowerCase();
    const segments = strict
        ? DEMO_LIKE_PATH_SEGMENTS_STRICT
        : DEMO_LIKE_PATH_SEGMENTS_SOFT;
    return segments.some((segment) => normalizedPath.includes(segment));
}

/**
 * 判断文件是否为组件目录入口文件（index.js / index.ts / index.tsx / index.jsx）。
 * 入口文件是组件的公共 API，应优先于内部子文件被推荐。
 */
function isIndexFile(filePath: string): boolean {
    const basename = filePath.split('/').pop()?.toLowerCase() ?? '';
    return /^index\.(js|ts|tsx|jsx)$/.test(basename);
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

    if (queriedBy === QUERIED_BY.SEMANTIC) {
        return (
            (item.score >= MIN_RECOMMENDATION_SCORE.semantic &&
                (item.reason.textMatch.score >= MIN_SEMANTIC_TEXT_MATCH_SCORE ||
                    hasRequiredFieldMatch)) ||
            (hasLiteralMatch && item.score >= MIN_LITERAL_MATCH_SCORE)
        );
    }

    return (
        item.score >= MIN_RECOMMENDATION_SCORE.keyword ||
        (hasRequiredFieldMatch &&
            item.score >= REQUIRED_FIELD_FALLBACK_MIN_SCORE)
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
        score += LITERAL_MATCH_PRIORITY_BOOST;
        notes.push('名称或文件名命中查询');
    }

    if (isIndexFile(path)) {
        score += INDEX_FILE_PRIORITY_BOOST;
        notes.push('组件目录入口文件优先');
    }

    if (isDemoLikePath(path)) {
        score -= DEMO_PATH_PRIORITY_PENALTY;
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

type PriorityScoredEntry = {
    item: ReturnType<typeof rankSemanticHits>[number];
    adjustedScore: number;
    adjustedReason: string;
};

/**
 * 同目录 index 文件降权：当结果集中某目录已有 index 文件时，对该目录内其他子文件扭扣分，
 * 解决 index.js 因内容稀疏（仅有 re-export）导致 embedding 分低而被内部子文件抑制的问题。
 */
function applyDirectoryIndexPenalty(
    entries: PriorityScoredEntry[]
): PriorityScoredEntry[] {
    // 找出结果集中哪些目录已有 index 文件
    const dirsWithIndex = new Set<string>();
    for (const entry of entries) {
        const p = entry.item.symbol.path;
        if (isIndexFile(p)) {
            const dir = p.includes('/')
                ? p.substring(0, p.lastIndexOf('/'))
                : '';
            dirsWithIndex.add(dir);
        }
    }
    if (dirsWithIndex.size === 0) return entries;

    // 对同目录中的非入口文件手动扣分
    return entries.map((entry) => {
        const p = entry.item.symbol.path;
        if (isIndexFile(p)) return entry;
        const dir = p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '';
        if (!dirsWithIndex.has(dir)) return entry;
        const newScore = Number(
            Math.max(
                0,
                entry.adjustedScore - SAME_DIR_INDEX_EXISTS_PENALTY
            ).toFixed(3)
        );
        return {
            ...entry,
            adjustedScore: newScore,
            adjustedReason: `${entry.adjustedReason} + 同目录入口文件已命中，内部子文件降权`,
        };
    });
}

interface EvalTraceAccumulator {
    semanticIds: Set<number>;
    reusableIds: Set<number>;
    combinedIds: Set<number>;
    qualifiedIds: Set<number>;
    returnedIds: Set<number>;
}

function accToEvalTrace(acc: EvalTraceAccumulator): EvalTrace {
    return {
        semanticIds: [...acc.semanticIds],
        reusableIds: [...acc.reusableIds],
        combinedIds: [...acc.combinedIds],
        qualifiedIds: [...acc.qualifiedIds],
        returnedIds: [...acc.returnedIds],
    };
}

export class RecommendationService {
    constructor(private readonly repository: SymbolRepository) {}

    /**
     * 根据查询和提示信息从仓库中获取候选结果，优先语义搜索并在出错时回退关键词搜索，返回搜索结果和相关的调试信息供后续处理使用。
     * @param query 查询字符串
     * @param searchTypes 搜索的符号类型
     * @param preferSemantic 是否优先使用语义搜索
     * @param limit 返回结果的数量限制
     * @returns 包含搜索结果和调试信息的对象
     */
    private async gatherSearchResults(
        query: string,
        searchTypes: SymbolType[],
        preferSemantic: boolean,
        limit: number
    ): Promise<{
        queriedBy: 'semantic' | 'keyword';
        searchResults: Array<{ symbol: CodeSymbol; similarity: number }>;
        fallbackReason: 'semantic_error_fallback_keyword' | null;
    }> {
        let queriedBy = preferSemantic
            ? QUERIED_BY.SEMANTIC
            : QUERIED_BY.KEYWORD;
        let fallbackReason: 'semantic_error_fallback_keyword' | null = null;

        if (preferSemantic) {
            try {
                const semanticGroups = await Promise.all(
                    searchTypes.map((type) =>
                        this.repository.searchSemanticHits(query, {
                            type,
                            limit: Math.max(
                                limit * STRUCTURE_LIMIT_MULTIPLIER,
                                STRUCTURE_LIMIT_MIN
                            ),
                        })
                    )
                );
                const searchResults = semanticGroups.flat();
                return {
                    queriedBy,
                    searchResults,
                    fallbackReason,
                };
            } catch {
                queriedBy = QUERIED_BY.KEYWORD;
                fallbackReason = FALLBACK_REASON.SEMANTIC_ERROR;
            }
        }

        const keywordGroups = await Promise.all(
            searchTypes.map((type) => this.repository.search(query, type))
        );
        return {
            queriedBy,
            searchResults: keywordGroups
                .flat()
                .map((symbol) => ({ symbol, similarity: 0 })),
            fallbackReason,
        };
    }

    /**
     * 对排名靠前的候选项进行详情补查
     */
    private async enrichTopCandidatesWithDetail(
        ranked: Array<ReturnType<typeof rankSemanticHits>[number]>
    ): Promise<{
        ranked: Array<ReturnType<typeof rankSemanticHits>[number]>;
        enrichedCount: number;
    }> {
        const topSymbols = ranked
            .slice(0, ENRICH_TOP_K)
            .map((item) => item.symbol);
        if (topSymbols.length === 0) {
            return { ranked, enrichedCount: 0 };
        }

        const detailMap = new Map<number, CodeSymbol>();
        await Promise.all(
            topSymbols.map(async (symbol) => {
                try {
                    const detail = await this.repository.getByName(symbol.name);
                    if (detail && detail.id === symbol.id) {
                        detailMap.set(symbol.id, detail);
                    }
                } catch {
                    // 详情补查失败时继续主流程，避免影响推荐输出。
                }
            })
        );

        if (detailMap.size === 0) {
            return { ranked, enrichedCount: 0 };
        }

        const enriched = ranked.map((item) => {
            const detail = detailMap.get(item.symbol.id);
            return detail ? { ...item, symbol: detail } : item;
        });

        return {
            ranked: enriched,
            enrichedCount: detailMap.size,
        };
    }

    /**
     * Agent 主循环：根据输入生成 query 变体，依次尝试多轮检索，融合语义/结构/关键词，Top-K 详情补查，质量门控，优先级调整。
     * 命中即返回推荐，否则遍历所有变体，最终输出 debug trace。
     */
    async recommendComponent(
        input: RecommendComponentInput
    ): Promise<RecommendComponentResult> {
        this.logStart(input);
        const {
            requiredProps,
            requiredHooks,
            structureFields,
            searchTypes,
            preferSemantic,
            limit,
            queryVariants,
        } = this.preprocessInput(input);
        let queriedBy = preferSemantic
            ? QUERIED_BY.SEMANTIC
            : QUERIED_BY.KEYWORD;
        let lastRankedCandidates: RecommendedCandidate[] = [];
        let lastCombinedCount = 0;
        let selectedQuery: string | null = null;
        let fallbackReason: 'semantic_error_fallback_keyword' | null = null;
        const attempts: RecommendationAttempt[] = [];
        const evalAcc: EvalTraceAccumulator | undefined = input.evalMode
            ? {
                  semanticIds: new Set(),
                  reusableIds: new Set(),
                  combinedIds: new Set(),
                  qualifiedIds: new Set(),
                  returnedIds: new Set(),
              }
            : undefined;

        this.logSearchTypes(searchTypes);

        for (const queryVariant of queryVariants) {
            const { attempt, combined, searchResults, gathered } =
                await this.tryQueryVariant({
                    queryVariant,
                    input,
                    searchTypes,
                    preferSemantic,
                    limit,
                    structureFields,
                    requiredProps,
                    requiredHooks,
                    evalAcc,
                });
            queriedBy = gathered.queriedBy;
            if (!fallbackReason && gathered.fallbackReason) {
                fallbackReason = gathered.fallbackReason;
            }
            lastCombinedCount = combined.length;
            this.logAttemptCheckpoint('attempt.summary', attempt);
            if (combined.length === 0) {
                attempt.skippedReason = SKIPPED_REASON.NO_COMBINED;
                this.logAttemptCheckpoint(
                    'attempt.skipped.no_combined',
                    attempt
                );
                attempts.push(attempt);
                continue;
            }

            const candidates = await this.rankAndEnrichCandidates({
                combined,
                searchResults,
                queryVariant,
                queriedBy,
                requiredProps,
                requiredHooks,
                attempt,
                limit,
                evalAcc,
            });
            lastRankedCandidates = candidates;
            if (candidates.length > 0) {
                selectedQuery = queryVariant;
                attempts.push(attempt);
                this.logAttemptCheckpoint('attempt.success', attempt);
                this.logAttemptsTrace('recommendComponent.result.found', {
                    selectedQuery,
                    queriedBy,
                    attempts,
                    fallbackReason,
                });
                return this.buildResult({
                    recommended: candidates[0] ?? null,
                    alternatives: candidates.slice(1, limit),
                    queriedBy,
                    requiredProps,
                    requiredHooks,
                    attempts,
                    selectedQuery,
                    fallbackReason,
                    evalTrace: evalAcc ? accToEvalTrace(evalAcc) : undefined,
                });
            }
            this.logAttemptCheckpoint(
                'attempt.no_candidate_after_rank',
                attempt
            );
            attempts.push(attempt);
        }
        this.logAttemptsTrace('recommendComponent.result.not_found', {
            selectedQuery,
            queriedBy,
            attempts,
            fallbackReason,
        });
        return this.buildResult({
            recommended: null,
            alternatives: [],
            queriedBy,
            requiredProps,
            requiredHooks,
            attempts,
            selectedQuery,
            fallbackReason,
            evalTrace: evalAcc ? accToEvalTrace(evalAcc) : undefined,
        });
    }

    private logStart(input: RecommendComponentInput) {
        console.error(
            '[code-intelligence-mcp] recommendComponent.start query=%s category=%s semantic=%s limit=%s requiredProps=%s requiredHooks=%s',
            input.query,
            input.category ?? '',
            String(input.semantic ?? true),
            String(input.limit ?? 5),
            JSON.stringify(input.requiredProps ?? []),
            JSON.stringify(input.requiredHooks ?? [])
        );
    }

    private logSearchTypes(searchTypes: SymbolType[]) {
        console.error(
            '[code-intelligence-mcp] recommendComponent.searchTypes types=%s',
            JSON.stringify(searchTypes)
        );
    }

    private preprocessInput(input: RecommendComponentInput) {
        const requiredProps = uniqueStrings(input.requiredProps);
        const requiredHooks = uniqueStrings(input.requiredHooks);
        const structureFields = uniqueStrings([
            ...requiredProps,
            ...requiredHooks,
        ]);
        const searchTypes = inferSearchTypes(input);
        const preferSemantic = input.semantic ?? true;
        const limit = input.limit ?? 5;
        const queryVariants = buildQueryVariants(input.query).slice(
            0,
            MAX_QUERY_VARIANTS
        );
        const res = {
            requiredProps,
            requiredHooks,
            structureFields,
            searchTypes,
            preferSemantic,
            limit,
            queryVariants,
        };
        console.error(
            '[code-intelligence-mcp] recommendComponent.preprocess queryVariants=%s requiredProps=%s requiredHooks=%s structureFields=%s searchTypes=%s preferSemantic=%s limit=%s',
            JSON.stringify(queryVariants),
            JSON.stringify(requiredProps),
            JSON.stringify(requiredHooks),
            JSON.stringify(structureFields),
            JSON.stringify(searchTypes),
            String(preferSemantic),
            String(limit)
        );
        return res;
    }

    private async tryQueryVariant({
        queryVariant,
        input,
        searchTypes,
        preferSemantic,
        limit,
        structureFields,
        requiredProps,
        requiredHooks,
        evalAcc,
    }: {
        queryVariant: string;
        input: RecommendComponentInput;
        searchTypes: SymbolType[];
        preferSemantic: boolean;
        limit: number;
        structureFields: string[];
        requiredProps: string[];
        requiredHooks: string[];
        evalAcc?: EvalTraceAccumulator;
    }) {
        const gathered = await this.gatherSearchResults(
            queryVariant,
            searchTypes,
            preferSemantic,
            limit
        );
        const searchResults = gathered.searchResults;
        if (evalAcc) {
            searchResults.forEach((r) => evalAcc.semanticIds.add(r.symbol.id));
        }
        const attempt: RecommendationAttempt = {
            query: queryVariant,
            queriedBy: gathered.queriedBy,
            searchCount: searchResults.length,
            structureCount: 0,
            combinedCount: 0,
            qualifiedCount: 0,
            detailEnrichedCount: 0,
        };
        const structureResults = structureFields.length
            ? (
                  await Promise.all(
                      searchTypes.map((type) =>
                          this.repository.searchByStructure(structureFields, {
                              type,
                              limit: Math.max(
                                  limit * STRUCTURE_LIMIT_MULTIPLIER,
                                  STRUCTURE_LIMIT_MIN
                              ),
                          })
                      )
                  )
              ).flat()
            : [];
        attempt.structureCount = structureResults.length;
        const mergedBeforeCategory = mergeCandidates([
            ...structureResults,
            ...searchResults.map((item) => item.symbol),
        ]);
        let combined = mergedBeforeCategory.filter((symbol) =>
            input.category
                ? (symbol.category ?? '')
                      .toLowerCase()
                      .includes(input.category.toLowerCase())
                : true
        );
        if (
            combined.length === 0 &&
            input.category &&
            mergedBeforeCategory.length
        ) {
            combined = mergedBeforeCategory;
        }
        const reusableCandidates = combined.filter(isReusableCandidate);
        if (reusableCandidates.length > 0) {
            combined = reusableCandidates;
        }
        if (evalAcc) {
            reusableCandidates.forEach((s) => evalAcc.reusableIds.add(s.id));
            combined.forEach((s) => evalAcc.combinedIds.add(s.id));
        }
        attempt.combinedCount = combined.length;
        return { attempt, combined, searchResults, gathered };
    }

    private async rankAndEnrichCandidates({
        combined,
        searchResults,
        queryVariant,
        queriedBy,
        requiredProps,
        requiredHooks,
        attempt,
        limit,
        evalAcc,
    }: {
        combined: CodeSymbol[];
        searchResults: Array<{ symbol: CodeSymbol; similarity: number }>;
        queryVariant: string;
        queriedBy: 'semantic' | 'keyword';
        requiredProps: string[];
        requiredHooks: string[];
        attempt: RecommendationAttempt;
        limit: number;
        evalAcc?: EvalTraceAccumulator;
    }): Promise<RecommendedCandidate[]> {
        const ranked =
            queriedBy === QUERIED_BY.SEMANTIC
                ? rankSemanticHits(
                      combined.map((symbol) => ({
                          symbol,
                          similarity:
                              searchResults.find(
                                  (item) => item.symbol.id === symbol.id
                              )?.similarity ?? 0.55,
                      })),
                      queryVariant
                  )
                : rankSymbols(queryVariant, combined);

        // 优先级预排序：仅依赖 name/path，无需 meta，前置到详情补查之前。
        // 目的：确保补查的 Top-K 是优先级调整后最可能命中的候选，
        // 避免高语义分但字面命中弱的候选占据补查名额，遗漏字面强命中的候选。
        const priorityScored = ranked.map((item) => {
            const adjusted = computeRecommendationPriority(item, queryVariant);
            return {
                item,
                adjustedScore: adjusted.score,
                adjustedReason: adjusted.reason,
            };
        });
        priorityScored.sort((a, b) => b.adjustedScore - a.adjustedScore);

        // 同目录 index 文件降权：对同目录非入口子文件扭扣，确保 index.js > menu.js / panel.js
        const reranked = applyDirectoryIndexPenalty(priorityScored);
        reranked.sort((a, b) => b.adjustedScore - a.adjustedScore);

        // 对优先级预排序后的 Top-K 做详情补查（getByName 补全完整 meta）
        const enriched = await this.enrichTopCandidatesWithDetail(
            reranked.map((e) => e.item)
        );
        attempt.detailEnrichedCount = enriched.enrichedCount;

        // 将补查结果回填到 reranked，保持优先级排序
        const enrichedPriorityScored = enriched.ranked.map((item, idx) => ({
            item,
            adjustedScore: reranked[idx]?.adjustedScore ?? item.score,
            adjustedReason:
                reranked[idx]?.adjustedReason ?? item.reason.summary,
        }));

        // 质量门控：score 阈值 + requiredProps/Hooks 命中校验（依赖完整 meta，必须在补查之后）
        const qualifiedRanked = enrichedPriorityScored.filter((entry) =>
            isStrongEnoughRecommendation(
                entry.item,
                queryVariant,
                queriedBy,
                requiredProps,
                requiredHooks
            )
        );
        attempt.qualifiedCount = qualifiedRanked.length;
        if (qualifiedRanked.length === 0) {
            attempt.skippedReason = SKIPPED_REASON.NO_QUALIFIED;
        }
        if (evalAcc) {
            qualifiedRanked.forEach((e) =>
                evalAcc.qualifiedIds.add(e.item.symbol.id)
            );
        }

        // 已按优先级排序，直接构建候选结果
        const candidates = qualifiedRanked.map((entry) =>
            toCandidate(
                entry.item.symbol,
                entry.adjustedScore,
                entry.adjustedReason,
                requiredProps,
                requiredHooks
            )
        );
        if (evalAcc) {
            candidates.forEach((c) => evalAcc.returnedIds.add(c.id));
        }
        console.error(
            '[code-intelligence-mcp] recommendComponent.rank query=%s queriedBy=%s enriched=%s qualified=%s candidates=%s',
            queryVariant,
            queriedBy,
            String(enrichedPriorityScored.length),
            String(qualifiedRanked.length),
            String(candidates.length)
        );
        return candidates;
    }

    private logAttemptCheckpoint(
        stage: string,
        attempt: RecommendationAttempt
    ) {
        console.error(
            '[code-intelligence-mcp] recommendComponent.%s query=%s queriedBy=%s search=%s structure=%s combined=%s qualified=%s enriched=%s skipped=%s',
            stage,
            attempt.query,
            attempt.queriedBy,
            String(attempt.searchCount),
            String(attempt.structureCount),
            String(attempt.combinedCount),
            String(attempt.qualifiedCount),
            String(attempt.detailEnrichedCount),
            attempt.skippedReason ?? 'none'
        );
    }

    private logAttemptsTrace(
        stage: string,
        payload: {
            selectedQuery: string | null;
            queriedBy: 'semantic' | 'keyword';
            attempts: RecommendationAttempt[];
            fallbackReason: 'semantic_error_fallback_keyword' | null;
        }
    ) {
        console.error(
            '[code-intelligence-mcp] %s selectedQuery=%s queriedBy=%s attempts=%s fallbackReason=%s',
            stage,
            payload.selectedQuery ?? 'none',
            payload.queriedBy,
            JSON.stringify(payload.attempts),
            payload.fallbackReason ?? 'none'
        );
    }

    private buildResult({
        recommended,
        alternatives,
        queriedBy,
        requiredProps,
        requiredHooks,
        attempts,
        selectedQuery,
        fallbackReason,
        evalTrace,
    }: {
        recommended: RecommendedCandidate | null;
        alternatives: RecommendedCandidate[];
        queriedBy: 'semantic' | 'keyword';
        requiredProps: string[];
        requiredHooks: string[];
        attempts: RecommendationAttempt[];
        selectedQuery: string | null;
        fallbackReason: 'semantic_error_fallback_keyword' | null;
        evalTrace?: EvalTrace;
    }): RecommendComponentResult {
        return {
            recommended,
            alternatives,
            queriedBy,
            structureFilter: {
                requiredProps,
                requiredHooks,
            },
            message:
                recommended !== null
                    ? RECOMMENDATION_MESSAGE.FOUND
                    : RECOMMENDATION_MESSAGE.NOT_FOUND,
            debug: {
                attempts,
                selectedQuery,
                retryUsed: attempts.length > 1,
                fallbackReason,
            },
            evalTrace,
        };
    }
}
