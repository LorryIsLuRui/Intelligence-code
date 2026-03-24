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
      "Rebuild symbols index from source files and write to MySQL. Use dryRun=true to only preview extraction count.",
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
