// rank 策略，用于排序搜索结果，排序依据为：文本匹配度、使用频率、最近更新时间、是否在 common 目录下
import type { CodeSymbol } from "../types/symbol.js";

export interface RankingReason {
  textMatch: {
    score: number;
    matchedBy: "exact_name" | "name_contains" | "description_contains" | "weak";
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

function textMatchScore(query: string, symbol: CodeSymbol): { score: number; matchedBy: RankingReason["textMatch"]["matchedBy"] } {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, matchedBy: "weak" };
  const name = symbol.name.toLowerCase();
  const description = (symbol.description ?? "").toLowerCase();
  if (name === q) return { score: 1, matchedBy: "exact_name" };
  if (name.includes(q)) return { score: 0.85, matchedBy: "name_contains" };
  if (description.includes(q)) return { score: 0.65, matchedBy: "description_contains" };
  return { score: 0.2, matchedBy: "weak" };
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
  return lower.includes("/common/") || lower.includes("/shared/") ? 1 : 0.35;
}

const RANK_WEIGHTS = {
  textMatch: 0.5,
  usage: 0.3,
  recency: 0.1,
  commonPath: 0.1
} as const;

export function rankSymbols(query: string, symbols: CodeSymbol[]): RankedSymbol[] {
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
      if (text.score >= 0.85) reasonParts.push("text match high");
      else if (text.score >= 0.65) reasonParts.push("description matched");
      if (usage >= 0.6) reasonParts.push("high usage");
      if (common >= 1) reasonParts.push("shared/common path");
      if (reasonParts.length === 0) reasonParts.push("balanced relevance");
      return {
        symbol,
        score: Number(score.toFixed(3)),
        reason: {
          textMatch: {
            score: Number(text.score.toFixed(3)),
            matchedBy: text.matchedBy
          },
          usage: {
            score: Number(usage.toFixed(3)),
            usageCount: symbol.usageCount
          },
          recency: {
            score: Number(recency.toFixed(3)),
            daysSinceCreated: daysSinceCreated(symbol.createdAt)
          },
          commonPath: {
            score: Number(common.toFixed(3)),
            isCommonPath: common >= 1
          },
          weights: RANK_WEIGHTS,
          summary: reasonParts.join(" + ")
        }
      };
    })
    .sort((a, b) => b.score - a.score);
}
