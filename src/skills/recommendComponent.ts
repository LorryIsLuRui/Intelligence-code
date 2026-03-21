import type { SymbolRepository } from "../repositories/symbolRepository.js";

export async function recommendComponent(query: string, repository: SymbolRepository) {
  const candidates = await repository.search(query, "component");
  const ranked = candidates
    .map((item) => ({
      ...item,
      score: item.usageCount * 0.3 + (item.description?.toLowerCase().includes(query.toLowerCase()) ? 0.7 : 0.5)
    }))
    .sort((a, b) => b.score - a.score);

  return ranked.slice(0, 3).map((item) => ({
    name: item.name,
    score: Number(item.score.toFixed(2)),
    reason: "keyword match + usage weight"
  }));
}
