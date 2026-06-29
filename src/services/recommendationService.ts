/**
 * recommendationService.ts — 统一的代码推荐管道。
 *
 * Pipeline:
 *   Step 1: extractQueryKeywords(rawQuery)              → 毫秒级本地特征词提取
 *   Step 2: callLLMToRewrite(rawQuery, keywords)         → LLM 熔炼为英文伪文档
 *   Step 3: embed(englishProse)                          → 单次 384 维向量化
 *   Step 4: Promise.all([BM25(keywords), HNSW(vector)])  → 两路并发检索
 *   Step 5: RRF 融合
 *   Step 6: rankSemanticHits + 优先级调整 + Enrich
 *   Step 7: 返回推荐结果
 */

import type { SymbolRepository } from '../repositories/symbolRepository.js';
import { rankSemanticHits, rankSymbols } from './ranking.js';
import type { CodeSymbol, SymbolType } from '../types/symbol.js';
import {
    DEMO_PATH_PRIORITY_PENALTY,
    INDEX_FILE_PRIORITY_BOOST,
    LITERAL_MATCH_PRIORITY_BOOST,
    SAME_DIR_INDEX_EXISTS_PENALTY,
} from '../config/tuning.js';
import { callLLMToRewrite, extractQueryKeywords } from './queryRewriter.js';
import { createEmbeddingClient } from './embeddingClient.js';
import { env } from '../config/env.js';
import type { EvalTrace } from '../types/evalTrace.js';

/** 查询方式标识 */
const QUERIED_BY = {
    SEMANTIC: 'semantic' as const,
    KEYWORD: 'keyword' as const,
};

/** 推荐结果文案 */
const RECOMMENDATION_MESSAGE = {
    FOUND: '已找到可复用组件候选，首选已按综合匹配度排序。',
    NOT_FOUND: '未找到符合条件的可复用组件。',
};

/** 详情补查的 top-k 条数 */
const ENRICH_TOP_K = 3;
/** 搜索 limit 倍数 */
const STRUCTURE_LIMIT_MULTIPLIER = 4;
/** 搜索 limit 最小值 */
const STRUCTURE_LIMIT_MIN = 12;

// ─── Interfaces ──────────────────────────────────────────────────────────────

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

// ─── Utilities ───────────────────────────────────────────────────────────────

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
        : DEMO_LIKE_PATH_SEGMENTS_STRICT.slice(0, 3);
    return segments.some((segment) => normalizedPath.includes(segment));
}

function isIndexFile(filePath: string): boolean {
    const basename = filePath.split('/').pop()?.toLowerCase() ?? '';
    return /^index\.(js|ts|tsx|jsx)$/.test(basename);
}

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

function extractLiteralTokens(query: string): string[] {
    const tokens = new Set<string>();
    const genericTokens = new Set([
        'component', 'components', 'hook', 'hooks',
        'util', 'utils', 'function', 'functions',
        'class', 'classes', 'type', 'types',
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

function applyDirectoryIndexPenalty(
    entries: PriorityScoredEntry[]
): PriorityScoredEntry[] {
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

    return entries.map((entry) => {
        const p = entry.item.symbol.path;
        if (isIndexFile(p)) return entry;
        const dir = p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '';
        if (!dirsWithIndex.has(dir)) return entry;
        const newScore = Number(
            Math.max(0, entry.adjustedScore - SAME_DIR_INDEX_EXISTS_PENALTY).toFixed(3)
        );
        return {
            ...entry,
            adjustedScore: newScore,
            adjustedReason: `${entry.adjustedReason} + 同目录入口文件已命中，内部子文件降权`,
        };
    });
}

/**
 * RRF（Reciprocal Rank Fusion）融合两路检索结果。
 * 对每路结果的排名取倒数作为分，合并后按总分降序。
 */
function fuseByRRF(
    semanticResults: Array<{ symbol: CodeSymbol; similarity: number }>,
    bm25Results: Array<{ symbol: CodeSymbol; score: number }>,
    k = 60
): Array<{ symbol: CodeSymbol; similarity: number }> {
    const rrfScores = new Map<number, number>();
    const symbolMap = new Map<number, CodeSymbol>();

    for (const [rank, item] of semanticResults.entries()) {
        rrfScores.set(
            item.symbol.id,
            (rrfScores.get(item.symbol.id) ?? 0) + 1 / (k + rank)
        );
        symbolMap.set(item.symbol.id, item.symbol);
    }
    for (const [rank, item] of bm25Results.entries()) {
        rrfScores.set(
            item.symbol.id,
            (rrfScores.get(item.symbol.id) ?? 0) + 1 / (k + rank)
        );
        symbolMap.set(item.symbol.id, item.symbol);
    }

    return [...rrfScores.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id, score]) => ({
            symbol: symbolMap.get(id)!,
            similarity: score,
        }));
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class RecommendationService {
    constructor(private readonly repository: SymbolRepository) {}

    /**
     * 统一推荐管道：
     *   1. extractQueryKeywords  → 纯净特征词
     *   2. LLM rewrite           → 英文伪文档
     *   3. embed                 → 384 维向量
     *   4. BM25 + HNSW 并发      → 两路独立检索
     *   5. RRF 融合              → 混合排序
     *   6. rank + enrich         → 综合排序 + 详情补查
     */
    async recommendComponent(
        input: RecommendComponentInput
    ): Promise<RecommendComponentResult> {
        this.logStart(input);
        const { requiredProps, requiredHooks, searchTypes, limit } =
            this.preprocessInput(input);

        // ── Step 1: 本地纯净特征词提取 ──────────────────────────────────────
        const keywords = extractQueryKeywords(input.query);
        console.error(
            '[code-intelligence-mcp] recommendComponent.step1.keywords keywords=%s',
            JSON.stringify(keywords)
        );

        // ── Step 2: LLM 熔炼为英文伪文档 ────────────────────────────────────
        let englishProse: string;
        try {
            englishProse = await callLLMToRewrite(input.query, keywords);
        } catch (err) {
            console.error(
                '[code-intelligence-mcp] recommendComponent.step2.llmRewriteError err=%s',
                String(err)
            );
            // LLM 不可用时回退：用 keywords 拼接作为 prose
            englishProse = `Looking for a ${searchTypes[0] ?? 'component'} related to: ${keywords.join(', ')}`;
        }
        console.error(
            '[code-intelligence-mcp] recommendComponent.step2.englishProse prose=%s',
            englishProse
        );

        // ── Step 3: Embedding ────────────────────────────────────────────────
        const maxLimit = Math.max(
            limit * STRUCTURE_LIMIT_MULTIPLIER,
            STRUCTURE_LIMIT_MIN
        );

        const [bm25Results, hnswResults] = await this.runConcurrentSearch(
            keywords,
            englishProse,
            searchTypes,
            maxLimit
        );

        if (bm25Results.length === 0 && hnswResults.length === 0) {
            console.error(
                '[code-intelligence-mcp] recommendComponent.noResultsBothPaths'
            );
            return this.buildResult({
                recommended: null,
                alternatives: [],
                queriedBy: QUERIED_BY.SEMANTIC,
                requiredProps,
                requiredHooks,
                attempts: [],
                selectedQuery: null,
                fallbackReason: null,
            });
        }

        // ── Step 5: RRF 融合 ────────────────────────────────────────────────
        const fused = fuseByRRF(hnswResults, bm25Results);
        console.error(
            '[code-intelligence-mcp] recommendComponent.step5.rrfFused count=%s',
            fused.length
        );

        // ── Step 6: rerank + 优先级调整 + Enrich ────────────────────────────
        const candidates = await this.rankAndBuildCandidates(
            fused,
            englishProse,
            requiredProps,
            requiredHooks,
            limit
        );

        if (candidates.length === 0) {
            return this.buildResult({
                recommended: null,
                alternatives: [],
                queriedBy: QUERIED_BY.SEMANTIC,
                requiredProps,
                requiredHooks,
                attempts: [
                    {
                        query: englishProse,
                        queriedBy: QUERIED_BY.SEMANTIC,
                        searchCount: fused.length,
                        structureCount: 0,
                        combinedCount: fused.length,
                        qualifiedCount: 0,
                        detailEnrichedCount: 0,
                    },
                ],
                selectedQuery: englishProse,
                fallbackReason: null,
            });
        }

        return this.buildResult({
            recommended: candidates[0] ?? null,
            alternatives: candidates.slice(1, limit),
            queriedBy: QUERIED_BY.SEMANTIC,
            requiredProps,
            requiredHooks,
            attempts: [
                {
                    query: englishProse,
                    queriedBy: QUERIED_BY.SEMANTIC,
                    searchCount: fused.length,
                    structureCount: 0,
                    combinedCount: fused.length,
                    qualifiedCount: candidates.length,
                    detailEnrichedCount: Math.min(ENRICH_TOP_K, candidates.length),
                },
            ],
            selectedQuery: englishProse,
            fallbackReason: null,
        });
    }

    /**
     * Step 3+4: Embed → 并发 BM25 + HNSW。
     * 若 embedding 服务不可用，降级为纯 BM25。
     */
    private async runConcurrentSearch(
        keywords: string[],
        englishProse: string,
        searchTypes: SymbolType[],
        limit: number
    ): Promise<[
        Array<{ symbol: CodeSymbol; score: number }>,
        Array<{ symbol: CodeSymbol; similarity: number }>,
    ]> {
        // BM25 路（始终可用）
        const bm25Promise = this.repository
            .searchBM25(keywords.join(' '), { type: searchTypes, limit })
            .catch(() => [] as Array<{ symbol: CodeSymbol; score: number }>);

        // HNSW 路（需 embedding 服务）
        const hnswPromise = this.embedAndSearchHNSW(englishProse, searchTypes, limit);

        return Promise.all([bm25Promise, hnswPromise]);
    }

    private async embedAndSearchHNSW(
        englishProse: string,
        searchTypes: SymbolType[],
        limit: number
    ): Promise<Array<{ symbol: CodeSymbol; similarity: number }>> {
        try {
            const client = createEmbeddingClient(env.embeddingServiceUrl);
            const [queryVec] = await client.embed([englishProse]);
            if (!queryVec?.length) return [];
            return await this.repository.searchByVector(queryVec, {
                type: searchTypes,
                limit,
            });
        } catch (err) {
            console.error(
                '[code-intelligence-mcp] recommendComponent.embedOrHnswError err=%s',
                String(err)
            );
            return [];
        }
    }

    /**
     * 综合排序 + 优先级调整 + Enrich（无质量门控）。
     */
    private async rankAndBuildCandidates(
        fused: Array<{ symbol: CodeSymbol; similarity: number }>,
        queryText: string,
        requiredProps: string[],
        requiredHooks: string[],
        limit: number
    ): Promise<RecommendedCandidate[]> {
        // 1. rankSemanticHits 综合排序
        const ranked = rankSemanticHits(fused, queryText);

        // 2. 优先级预排序（字面命中加分 / demo 路径减分）
        const priorityScored = ranked.map((item) => {
            const adjusted = computeRecommendationPriority(item, queryText);
            return {
                item,
                adjustedScore: adjusted.score,
                adjustedReason: adjusted.reason,
            };
        });
        priorityScored.sort((a, b) => b.adjustedScore - a.adjustedScore);

        // 3. 同目录 index 文件降权
        const reranked = applyDirectoryIndexPenalty(priorityScored);
        reranked.sort((a, b) => b.adjustedScore - a.adjustedScore);

        // 4. Enrich（补全 meta / callers / sideEffects）
        const enriched = await this.enrichTopCandidatesWithDetail(
            reranked.map((e) => e.item)
        );

        // 5. 回填 enrichment 结果到 reranked 排序
        const enrichedScored = enriched.ranked.map((item, idx) => ({
            item,
            adjustedScore: reranked[idx]?.adjustedScore ?? item.score,
            adjustedReason:
                reranked[idx]?.adjustedReason ?? item.reason.summary,
        }));

        return enrichedScored.map((entry) =>
            toCandidate(
                entry.item.symbol,
                entry.adjustedScore,
                entry.adjustedReason,
                requiredProps,
                requiredHooks
            )
        );
    }

    /**
     * 对排名靠前的候选项进行详情补查（callers / sideEffects 等）。
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
                    // 详情补查失败时继续主流程
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

    // ─── Input 预处理 ────────────────────────────────────────────────────────

    private preprocessInput(input: RecommendComponentInput) {
        const requiredProps = uniqueStrings(input.requiredProps);
        const requiredHooks = uniqueStrings(input.requiredHooks);
        const searchTypes = inferSearchTypes(input);
        const limit = input.limit ?? 5;
        const res = { requiredProps, requiredHooks, searchTypes, limit };
        console.error(
            '[code-intelligence-mcp] recommendComponent.preprocess searchTypes=%s requiredProps=%s requiredHooks=%s limit=%s',
            JSON.stringify(searchTypes),
            JSON.stringify(requiredProps),
            JSON.stringify(requiredHooks),
            String(limit)
        );
        return res;
    }

    // ─── Logging ─────────────────────────────────────────────────────────────

    private logStart(input: RecommendComponentInput) {
        console.error(
            '[code-intelligence-mcp] recommendComponent.start query=%s category=%s limit=%s requiredProps=%s requiredHooks=%s',
            input.query,
            input.category ?? '',
            String(input.limit ?? 5),
            JSON.stringify(input.requiredProps ?? []),
            JSON.stringify(input.requiredHooks ?? [])
        );
    }

    // ─── Result builder ──────────────────────────────────────────────────────

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
                retryUsed: false,
                fallbackReason,
            },
            evalTrace,
        };
    }
}