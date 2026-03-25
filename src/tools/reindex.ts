import { z } from "zod";
import { runReindex } from "../services/reindex.js";

export const reindexInput = z.object({
  projectRoot: z.string().optional(),
  globPatterns: z.array(z.string().min(1)).optional(),
  ignore: z.array(z.string().min(1)).optional(),
  dryRun: z.boolean().optional().default(false)
});

export function createReindexTool() {
  return {
    name: "reindex",
    description:
      "重建源码符号索引并写入 MySQL；设置 dryRun=true 时仅预览抽取数量，不落库、不调用嵌入服务。若配置 EMBEDDING_SERVICE_URL，非 dryRun 时会写入向量列。",
    inputSchema: reindexInput.shape,
    handler: async (input: z.infer<typeof reindexInput>) => {
      const startedAt = Date.now();
      const result = await runReindex({
        projectRoot: input.projectRoot,
        globPatterns: input.globPatterns,
        ignore: input.ignore,
        dryRun: input.dryRun
      });
      const elapsedMs = Date.now() - startedAt;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                ...result,
                elapsedMs
              },
              null,
              2
            )
          }
        ]
      };
    }
  };
}
