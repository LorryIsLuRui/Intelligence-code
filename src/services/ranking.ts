// rank 策略，用于排序搜索结果，排序依据为：文本匹配度、使用频率、最近更新时间、是否在 common 目录下
import type { CodeSymbol } from '../types/symbol.js';
import {
    CALLEE_MATCH_SCORE_MAX,
    CALLEE_MATCH_SCORE_PER_MATCH,
    COMMON_PATH_SCORE_NO,
    COMMON_PATH_SCORE_YES,
    RANK_WEIGHTS,
    RECENCY_SCORE_DEFAULT,
    RECENCY_SCORE_OLDEST,
    RECENCY_SCORE_TIERS,
    SEMANTIC_REASON_THRESHOLD_HIGH,
    SEMANTIC_REASON_THRESHOLD_MED,
    TEXT_MATCH_SCORES,
    TOKEN_OVERLAP_TIERS,
    USAGE_REASON_THRESHOLD_HIGH,
    USAGE_SCORE_LOG_DIVISOR,
} from '../config/tuning.js';

export interface RankingReason {
    textMatch: {
        score: number;
        matchedBy:
            | 'exact_name'
            | 'name_contains'
            | 'description_contains'
            | 'token_overlap'
            | 'weak'
            | 'semantic';
    };
    usage: {
        score: number;
        usageCount: number;
    };
    recency: {
        score: number;
        daysSinceCreated: number | null;
    };
    commonPath: {
        score: number;
        isCommonPath: boolean;
    };
    weights: {
        textMatch: number;
        usage: number;
        recency: number;
        commonPath: number;
    };
    summary: string;
}

export interface RankedSymbol {
    symbol: CodeSymbol;
    score: number;
    reason: RankingReason;
}

function clamp01(value: number): number {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}
function extractTextTokens(text: string): string[] {
    // eg: query='useDebounceInput组件', tokens=['useDebounceInput', '组件']
    const tokens = new Set<string>();
    const lower = text.trim().toLowerCase();
    for (const match of lower.matchAll(/[a-z0-9_]+/g)) {
        if (match[0].length >= 2) tokens.add(match[0]);
    }
    for (const match of text.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
        const chunk = match[0];
        for (let index = 0; index < chunk.length - 1; index += 1) {
            tokens.add(chunk.slice(index, index + 2));
        }
    }
    return [...tokens];
}
// 先对query进行切分，然后计算切分后的token在symbol的name/description/path中出现的数量和比例，来判断是否存在关键词重合，进而提升排名。
function tokenOverlapScore(query: string, symbol: CodeSymbol): number {
    const queryTokens = extractTextTokens(query);
    if (queryTokens.length === 0) return 0;

    const text = [symbol.name, symbol.description ?? '', symbol.path]
        .join(' ')
        .toLowerCase();
    const matched = queryTokens.filter((token) => text.includes(token)).length;
    const overlapRatio = matched / queryTokens.length;

    for (const tier of TOKEN_OVERLAP_TIERS) {
        if (matched >= tier.minMatches && overlapRatio >= tier.minRatio) {
            return tier.score;
        }
    }
    return 0;
}

function textMatchScore(
    query: string,
    symbol: CodeSymbol
): { score: number; matchedBy: RankingReason['textMatch']['matchedBy'] } {
    const q = query.trim().toLowerCase();
    if (!q) return { score: 0, matchedBy: 'weak' };
    const name = symbol.name.toLowerCase();
    const description = (symbol.description ?? '').toLowerCase();
    if (name === q) return { score: 1, matchedBy: 'exact_name' };
    if (name.includes(q))
        return {
            score: TEXT_MATCH_SCORES.nameContains,
            matchedBy: 'name_contains',
        };
    if (description.includes(q))
        return {
            score: TEXT_MATCH_SCORES.descriptionContains,
            matchedBy: 'description_contains',
        };
    const overlapScore = tokenOverlapScore(query, symbol);
    if (overlapScore > 0)
        return { score: overlapScore, matchedBy: 'token_overlap' };
    return { score: TEXT_MATCH_SCORES.weak, matchedBy: 'weak' };
}

function usageScore(usageCount: number): number {
    // log scale to avoid very large usage monopolizing ranking.
    return clamp01(Math.log10(usageCount + 1) / USAGE_SCORE_LOG_DIVISOR);
}

function recencyScore(createdAt?: string | null): number {
    if (!createdAt) return RECENCY_SCORE_DEFAULT;
    const ts = new Date(createdAt).getTime();
    if (Number.isNaN(ts)) return RECENCY_SCORE_DEFAULT;
    const days = (Date.now() - ts) / (1000 * 60 * 60 * 24);
    for (const tier of RECENCY_SCORE_TIERS) {
        if (days <= tier.maxDays) return tier.score;
    }
    return RECENCY_SCORE_OLDEST;
}

function daysSinceCreated(createdAt?: string | null): number | null {
    if (!createdAt) return null;
    const ts = new Date(createdAt).getTime();
    if (Number.isNaN(ts)) return null;
    return Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24));
}

function commonPathScore(path: string): number {
    const lower = path.toLowerCase();
    return lower.includes('/common/') || lower.includes('/shared/')
        ? COMMON_PATH_SCORE_YES
        : COMMON_PATH_SCORE_NO;
}

/**
 * Phase 5：以向量余弦相似度作为主文本维度，再叠加 usage / recency / common 和 calleeNames 匹配度。
 * calleeNames 作为结构信息独立信号，不污染纯语义向量。
 */
export function rankSemanticHits(
    hits: Array<{ symbol: CodeSymbol; similarity: number }>,
    query?: string
): RankedSymbol[] {
    return hits
        .map(({ symbol, similarity }) => {
            const textScore = clamp01(similarity);
            const usage = usageScore(symbol.usageCount);
            const recency = recencyScore(symbol.createdAt);
            const common = commonPathScore(symbol.path);

            // ✨ 新增：calleeNames 作为独立信号
            let calleeMatchScore = 0;
            if (query && Array.isArray(symbol.meta?.calleeNames)) {
                const calleeNames = symbol.meta.calleeNames as string[];
                const queryLower = query.toLowerCase();
                const matchedCallees = calleeNames.filter((callee) =>
                    queryLower.includes(callee.toLowerCase())
                ).length;
                if (matchedCallees > 0) {
                    calleeMatchScore = Math.min(
                        matchedCallees * CALLEE_MATCH_SCORE_PER_MATCH,
                        CALLEE_MATCH_SCORE_MAX
                    );
                }
            }

            const score =
                textScore * RANK_WEIGHTS.textMatch +
                usage * RANK_WEIGHTS.usage +
                recency * RANK_WEIGHTS.recency +
                common * RANK_WEIGHTS.commonPath +
                calleeMatchScore;
            const reasonParts: string[] = [];
            if (textScore >= SEMANTIC_REASON_THRESHOLD_HIGH)
                reasonParts.push('语义相似度高');
            else if (textScore >= SEMANTIC_REASON_THRESHOLD_MED)
                reasonParts.push('语义相关');
            if (usage >= USAGE_REASON_THRESHOLD_HIGH)
                reasonParts.push('使用频率高');
            if (common >= COMMON_PATH_SCORE_YES)
                reasonParts.push('位于 shared/common 路径');
            if (calleeMatchScore > 0) reasonParts.push('函数调用关系匹配');
            if (reasonParts.length === 0) reasonParts.push('综合相关性较好');
            return {
                symbol,
                score: Number(score.toFixed(3)),
                reason: {
                    textMatch: {
                        score: Number(textScore.toFixed(3)),
                        matchedBy: 'semantic' as const,
                    },
                    usage: {
                        score: Number(usage.toFixed(3)),
                        usageCount: symbol.usageCount,
                    },
                    recency: {
                        score: Number(recency.toFixed(3)),
                        daysSinceCreated: daysSinceCreated(symbol.createdAt),
                    },
                    commonPath: {
                        score: Number(common.toFixed(3)),
                        isCommonPath: common >= COMMON_PATH_SCORE_YES,
                    },
                    weights: RANK_WEIGHTS,
                    summary: reasonParts.join(' + '),
                },
            };
        })
        .sort((a, b) => b.score - a.score);
}

export function rankSymbols(
    query: string,
    symbols: CodeSymbol[]
): RankedSymbol[] {
    return symbols
        .map((symbol) => {
            const text = textMatchScore(query, symbol);
            const usage = usageScore(symbol.usageCount);
            const recency = recencyScore(symbol.createdAt);
            const common = commonPathScore(symbol.path);
            const score =
                text.score * RANK_WEIGHTS.textMatch +
                usage * RANK_WEIGHTS.usage +
                recency * RANK_WEIGHTS.recency +
                common * RANK_WEIGHTS.commonPath;
            const reasonParts: string[] = [];
            if (text.score >= TEXT_MATCH_SCORES.nameContains)
                reasonParts.push('文本匹配度高');
            else if (text.score >= TEXT_MATCH_SCORES.descriptionContains)
                reasonParts.push('描述命中');
            else if (text.matchedBy === 'token_overlap')
                reasonParts.push('关键词片段高度重合');
            if (usage >= USAGE_REASON_THRESHOLD_HIGH)
                reasonParts.push('使用频率高');
            if (common >= COMMON_PATH_SCORE_YES)
                reasonParts.push('位于 shared/common 路径');
            if (reasonParts.length === 0) reasonParts.push('综合相关性较好');
            return {
                symbol,
                score: Number(score.toFixed(3)),
                reason: {
                    textMatch: {
                        score: Number(text.score.toFixed(3)),
                        matchedBy: text.matchedBy,
                    },
                    usage: {
                        score: Number(usage.toFixed(3)),
                        usageCount: symbol.usageCount,
                    },
                    recency: {
                        score: Number(recency.toFixed(3)),
                        daysSinceCreated: daysSinceCreated(symbol.createdAt),
                    },
                    commonPath: {
                        score: Number(common.toFixed(3)),
                        isCommonPath: common >= COMMON_PATH_SCORE_YES,
                    },
                    weights: RANK_WEIGHTS,
                    summary: reasonParts.join(' + '),
                },
            };
        })
        .sort((a, b) => b.score - a.score);
}
