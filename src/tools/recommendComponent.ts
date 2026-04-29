import { z } from 'zod';
import type { RecommendationService } from '../services/recommendationService.js';

type RecommendResult = Awaited<
    ReturnType<RecommendationService['recommendComponent']>
>;

function formatCallers(callers: Array<{ name: string; path: string }>): string {
    if (!callers.length) return '新增';
    return callers.map((caller) => `${caller.name}(${caller.path})`).join('; ');
}

function formatSideEffects(sideEffects: string[]): string {
    return sideEffects.length ? sideEffects.join('/') : '无';
}

function formatHasResult(result: RecommendResult): string {
    const recommended = result.recommended;
    if (!recommended) return '';

    const reasons: string[] = [];
    if (recommended.matchedProps.length) {
        reasons.push(
            `匹配到必需 props：${recommended.matchedProps.join(', ')}`
        );
    }
    if (recommended.matchedHooks.length) {
        reasons.push(
            `匹配到必需 hooks：${recommended.matchedHooks.join(', ')}`
        );
    }
    if (reasons.length < 2) {
        reasons.push('综合语义、结构字段和可复用性排序后为首选。');
    }

    const alternatives = result.alternatives.length
        ? result.alternatives
              .map(
                  (item) =>
                      `${item.name}（${formatSideEffects(item.sideEffects)}）`
              )
              .join('; ')
        : '无';

    return `首选：${recommended.name} — ${recommended.path}
symbolId：${recommended.id}
使用范围：${formatCallers(recommended.callers)}
副作用：${formatSideEffects(recommended.sideEffects)}
理由：
1. ${reasons[0] ?? '匹配度最高，适合直接复用。'}
2. ${reasons[1] ?? 'API 形态与需求一致，接入成本低。'}
其他候选：${alternatives}
用法提示：
\`\`\`tsx
<${recommended.name} value={value} onChange={handleChange} />
\`\`\`
是否采纳（**请在聊天框输入 1 或 2**）：
1️⃣ 采纳推荐 — 自动调用 inc_usage 记录使用
2️⃣ 取消`;
}

function formatNoResult(): string {
    return `首选：未找到已有实现
使用范围：无
副作用：无
理由：
1. 当前索引中没有满足条件的组件（例如必须包含 onChange）
2. 已尝试可用检索方式，仍无可用候选
其他候选：无
用法提示：
\`\`\`tsx
// 可先创建一个受控 Input 组件，至少暴露 value + onChange
\`\`\`
是否采纳（**请在聊天框输入 1 或 2**）：
1️⃣ 新建最小可复用组件
2️⃣ 取消`;
}

function formatReply(result: RecommendResult): string {
    return result.recommended ? formatHasResult(result) : formatNoResult();
}

export const recommendComponentInput = z.object({
    query: z.string().min(1),
    requiredProps: z.array(z.string().min(1)).optional(),
    requiredHooks: z.array(z.string().min(1)).optional(),
    category: z.string().optional(),
    semantic: z.boolean().optional().default(true),
    limit: z.number().int().min(1).max(10).optional().default(5),
});

export function createRecommendComponentTool(
    recommendationService: RecommendationService
) {
    return {
        name: 'recommend_component',
        description:
            '【降级链第一步，唯一首选工具】当用户询问有没有可复用的组件/函数/util，或需要找仓库中现有实现时，必须先调用本工具。\n' +
            '本工具会自动完成候选搜索、结构过滤和首选推荐，无需再调其他搜索工具。\n' +
            '⚠️ 输出约束（必须严格遵守）：\n' +
            '- recommended != null：立即将工具返回的文本原样输出给用户，完全停止，不得调用任何其他工具，不得改写为散文或追加说明。\n' +
            '- recommended = null：进入降级链第二步，调用 search_symbols（semantic=true）。\n' +
            '- 任何情况下禁止调用 grep/read file/file search 作为本工具的后续动作。',
        inputSchema: recommendComponentInput.shape,
        handler: async (input: z.infer<typeof recommendComponentInput>) => {
            console.error(
                '[code-intelligence-mcp] tool.recommend_component.called query=%s requiredProps=%s requiredHooks=%s category=%s semantic=%s limit=%s',
                input.query,
                JSON.stringify(input.requiredProps ?? []),
                JSON.stringify(input.requiredHooks ?? []),
                input.category ?? '',
                String(input.semantic ?? true),
                String(input.limit ?? 5)
            );

            try {
                const result =
                    await recommendationService.recommendComponent(input);
                console.error(
                    '[code-intelligence-mcp] tool.recommend_component.done recommended=%s alternatives=%s queriedBy=%s',
                    result.recommended ? 'yes' : 'no',
                    String(result.alternatives.length),
                    result.queriedBy
                );

                const formattedReply = formatReply(result);

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: formattedReply,
                        },
                    ],
                };
            } catch (error) {
                console.error(
                    '[code-intelligence-mcp] tool.recommend_component.error',
                    error
                );
                throw error;
            }
        },
    };
}
