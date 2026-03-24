import { z } from "zod";
import type { SymbolRepository } from "../repositories/symbolRepository.js";
import { rankSymbols } from "../services/ranking.js";

export const searchSymbolsInput = z.object({
  query: z.string().min(1),
  type: z.enum(["component", "util", "selector", "type"]).optional(),
  ranked: z.boolean().optional().default(true)
});

export function createSearchSymbolsTool(repository: SymbolRepository) {
  return {
    name: "search_symbols",
    description: "Search symbols by keyword and optional type. Use when user wants to find components, utils, or types.",
    inputSchema: searchSymbolsInput.shape,
    handler: async (input: z.infer<typeof searchSymbolsInput>) => {
      const rows = await repository.search(input.query, input.type);
      const resultRows = input.ranked
        ? rankSymbols(input.query, rows).map((item) => ({
            name: item.symbol.name,
            type: item.symbol.type,
            path: item.symbol.path,
            description: item.symbol.description,
            usageCount: item.symbol.usageCount,
            score: item.score,
          reason: item.reason.summary,
          reasonDetail: item.reason
          }))
        : rows.map((r) => ({
            name: r.name,
            type: r.type,
            path: r.path,
            description: r.description,
            usageCount: r.usageCount
          }));
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(resultRows, null, 2)
          }
        ]
      };
    }
  };
}
