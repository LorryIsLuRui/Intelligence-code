import { z } from 'zod';
import { runReindex } from '../services/reindex.js';

export const reindexInput = z.object({
    projectRoot: z.string().optional(),
    globPatterns: z.array(z.string().min(1)).optional(),
    ignore: z.array(z.string().min(1)).optional(),
    dryRun: z.boolean().optional().default(false),
});

export function createReindexTool() {
    return {
        name: 'reindex',
        description:
            '⚠️ 高成本操作（耗时可能超过数分钟），仅在用户明确要求"重建索引"时调用，不要因搜索结果不佳而自动调用。\n' +
            '重建源码代码块索引并写入 MySQL。设置 dryRun=true 时仅预览抽取数量，不落库。\n' +
            '写入后 embedding 由后台 worker 异步处理，队列清空后打印完成信号。',
        inputSchema: reindexInput.shape,
        handler: async (input: z.infer<typeof reindexInput>) => {
            const startedAt = Date.now();
            const result = await runReindex({
                projectRoot: input.projectRoot,
                globPatterns: input.globPatterns,
                ignore: input.ignore,
                dryRun: input.dryRun,
            });
            const elapsedMs = Date.now() - startedAt;

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(
                            {
                                ok: true,
                                ...result,
                                elapsedMs,
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        },
    };
}
