import { z } from "zod";
import { recommendComponent } from "../skills/recommendComponent.js";
import type { SymbolRepository } from "../repositories/symbolRepository.js";

export const recommendComponentInput = z.object({
  query: z.string().min(1),
  props: z.array(z.string().min(1)).optional(),
  limit: z.number().int().min(1).max(20).optional().default(3)
});

export function createRecommendComponentTool(repository: SymbolRepository) {
  return {
    name: "recommend_component",
    description:
      "基于关键词检索 + 可选结构过滤 + 排序 + 详情补全，推荐最合适的可复用组件。",
    inputSchema: recommendComponentInput.shape,
    handler: async (input: z.infer<typeof recommendComponentInput>) => {
      const result = await recommendComponent(input.query, repository, {
        props: input.props,
        limit: input.limit
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    }
  };
}
