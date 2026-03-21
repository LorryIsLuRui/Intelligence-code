import { z } from "zod";
import type { SymbolRepository } from "../repositories/symbolRepository.js";

export const searchSymbolsInput = z.object({
  query: z.string().min(1),
  type: z.enum(["component", "util", "selector", "type"]).optional()
});

export function createSearchSymbolsTool(repository: SymbolRepository) {
  return {
    name: "search_symbols",
    description: "Search symbols by keyword and optional type",
    inputSchema: searchSymbolsInput.shape,
    handler: async (input: z.infer<typeof searchSymbolsInput>) => {
      const rows = await repository.search(input.query, input.type);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              rows.map((r) => ({
                name: r.name,
                type: r.type,
                path: r.path,
                description: r.description,
                usageCount: r.usageCount
              })),
              null,
              2
            )
          }
        ]
      };
    }
  };
}
