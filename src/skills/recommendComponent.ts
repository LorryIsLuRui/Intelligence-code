import type { SymbolRepository } from "../repositories/symbolRepository.js";
import { rankSymbols } from "../services/ranking.js";

interface RecommendComponentOptions {
  props?: string[];
  limit?: number;
}

export interface RecommendComponentResult {
  query: string;
  requestedProps: string[];
  results: Array<{
    name: string;
    path: string;
    score: number;
    reason: string;
    reasonDetail: unknown;
    detail: unknown;
  }>;
}

export async function recommendComponent(
  query: string,
  repository: SymbolRepository,
  options: RecommendComponentOptions = {}
): Promise<RecommendComponentResult> {
  const requestedProps = options.props?.map((p) => p.trim()).filter(Boolean) ?? [];
  const limit = options.limit ?? 3;

  // Step 1: keyword candidate search
  const keywordCandidates = await repository.search(query, "component");

  // Step 2: optional structure filter
  const structureCandidates =
    requestedProps.length > 0
      ? await repository.searchByStructure(requestedProps, {
          type: "component",
          limit: Math.max(limit * 3, 20)
        })
      : [];

  const byName = new Map<string, (typeof keywordCandidates)[number]>();
  for (const row of keywordCandidates) byName.set(row.name, row);
  for (const row of structureCandidates) byName.set(row.name, row);

  // Step 3: ranking
  const ranked = rankSymbols(query, [...byName.values()]).slice(0, Math.max(limit * 3, 10));

  // Step 4: detail enrichment
  const enriched = await Promise.all(
    ranked.map(async (item) => {
      const detail = await repository.getByName(item.symbol.name);
      return {
        name: item.symbol.name,
        path: item.symbol.path,
        score: item.score,
        reason: item.reason.summary,
        reasonDetail: item.reason,
        detail
      };
    })
  );

  // Step 5: return top-N with reasons
  return {
    query,
    requestedProps,
    results: enriched.slice(0, limit)
  };
}
