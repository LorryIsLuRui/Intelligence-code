// rank 策略，用于排序搜索结果，排序依据为：文本匹配度、使用频率、最近更新时间、是否在 common 目录下
import type { CodeSymbol } from '../types/symbol.js';

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

    if (matched >= 4 && overlapRatio >= 0.45) return 0.78;
    if (matched >= 3 && overlapRatio >= 0.3) return 0.68;
    if (matched >= 2 && overlapRatio >= 0.18) return 0.56;
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
    if (name.includes(q)) return { score: 0.85, matchedBy: 'name_contains' };
    if (description.includes(q))
        return { score: 0.65, matchedBy: 'description_contains' };
    const overlapScore = tokenOverlapScore(query, symbol);
    if (overlapScore > 0)
        return { score: overlapScore, matchedBy: 'token_overlap' };
    return { score: 0.2, matchedBy: 'weak' };
}

function usageScore(usageCount: number): number {
    // log scale to avoid very large usage monopolizing ranking.
    return clamp01(Math.log10(usageCount + 1) / 3);
}

function recencyScore(createdAt?: string | null): number {
    if (!createdAt) return 0.4;
    const ts = new Date(createdAt).getTime();
    if (Number.isNaN(ts)) return 0.4;
    const days = (Date.now() - ts) / (1000 * 60 * 60 * 24);
    if (days <= 7) return 1;
    if (days <= 30) return 0.8;
    if (days <= 90) return 0.6;
    if (days <= 180) return 0.4;
    return 0.25;
}

function daysSinceCreated(createdAt?: string | null): number | null {
    if (!createdAt) return null;
    const ts = new Date(createdAt).getTime();
    if (Number.isNaN(ts)) return null;
    return Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24));
}

function commonPathScore(path: string): number {
    const lower = path.toLowerCase();
    return lower.includes('/common/') || lower.includes('/shared/') ? 1 : 0.35;
}

const RANK_WEIGHTS = {
    textMatch: 0.5,
    usage: 0.3,
    recency: 0.1,
    commonPath: 0.1,
} as const;

/**
 * Phase 5：以向量余弦相似度作为主文本维度，再叠加 usage / recency / common（与 `rankSymbols` 同权重）。
 */
export function rankSemanticHits(
    hits: Array<{ symbol: CodeSymbol; similarity: number }>
): RankedSymbol[] {
    return hits
        .map(({ symbol, similarity }) => {
            const textScore = clamp01(similarity);
            const usage = usageScore(symbol.usageCount);
            const recency = recencyScore(symbol.createdAt);
            const common = commonPathScore(symbol.path);
            const score =
                textScore * RANK_WEIGHTS.textMatch +
                usage * RANK_WEIGHTS.usage +
                recency * RANK_WEIGHTS.recency +
                common * RANK_WEIGHTS.commonPath;
            const reasonParts: string[] = [];
            if (textScore >= 0.55) reasonParts.push('语义相似度高');
            else if (textScore >= 0.4) reasonParts.push('语义相关');
            if (usage >= 0.6) reasonParts.push('使用频率高');
            if (common >= 1) reasonParts.push('位于 shared/common 路径');
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
                        isCommonPath: common >= 1,
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
            if (text.score >= 0.85) reasonParts.push('文本匹配度高');
            else if (text.score >= 0.65) reasonParts.push('描述命中');
            else if (text.matchedBy === 'token_overlap')
                reasonParts.push('关键词片段高度重合');
            if (usage >= 0.6) reasonParts.push('使用频率高');
            if (common >= 1) reasonParts.push('位于 shared/common 路径');
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
                        isCommonPath: common >= 1,
                    },
                    weights: RANK_WEIGHTS,
                    summary: reasonParts.join(' + '),
                },
            };
        })
        .sort((a, b) => b.score - a.score);
}
