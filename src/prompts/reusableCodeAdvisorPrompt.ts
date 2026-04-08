/**
 * MCP Prompt：与 Cursor Skill `.cursor/skills/reusable-code-advisor/SKILL.md` 正文对齐。
 * 若更新工作流/约束，请同步修改 SKILL.md 与本文件中的文案。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const REUSABLE_CODE_ADVISOR_DESCRIPTION =
    '在实现需求时检索并推荐最合适的可复用代码代码块（组件/函数/类/模块等）。在用户要求复用现有代码、询问是否已有组件/函数/服务、或要在多个代码块中选最优时使用。';

/** 与 SKILL.md 中 `# 可复用代码推荐` 起至约束、示例说明为止的正文一致（无 YAML frontmatter）。 */
const REUSABLE_CODE_ADVISOR_MARKDOWN = `# 可复用代码推荐

## 工作流

当用户需要可复用代码或实现类需求时，按顺序执行：

1. 调用 search_symbols 检索候选，type 根据用户需求传（component/util/selector/type）
2. 如果用户指定了结构过滤条件（props/params/properties/hooks），额外调用 search_by_structure 做结构匹配
3. 先 search_symbols(limit=20) 拉候选，再对 Top 3 调用 get_symbol_detail 做深度判断
4. 若仅凭签名/摘要无法判断，对最相关的若干候选调用 get_symbol_detail 获取详情
5. 从以下维度对比候选：
   - 与用户需求的**功能匹配度**
   - **API 是否简单**、入参是否合适
   - **依赖与副作用**风险
   - **复用安全性**（稳定性、耦合度、是否便于扩展）
6. 给出**唯一首选**推荐，并说明理由

## 回复结构

按此结构输出（字段名可保留英文或改为中文小标题，二选一全文统一）：

- **首选：** \`<代码块名>\`
- **理由：** 1～3 条要点
- **其他候选：** 简要列出及取舍
- **用法提示：** 结合用户场景的最小集成说明

## 约束

- 优先推荐已有可复用代码块，避免轻易建议新写一套。
- 若无合适代码块，明确说明，并给出最接近的选项及差距。
- 推理简洁，面向落地实现。

## 更多示例

与仓库内 \`.cursor/skills/reusable-code-advisor/examples.md\` 中的示例一致（在 Cursor 或本地打开该文件查看）。
`;

export function registerReusableCodeAdvisorPrompt(server: McpServer): void {
    server.prompt(
        'reusable-code-advisor',
        REUSABLE_CODE_ADVISOR_DESCRIPTION,
        {
            userRequest: z
                .string()
                .optional()
                .describe('用户当前需求或关键词，用于聚焦检索与推荐（可选）'),
        },
        async (args) => {
            const suffix = args.userRequest?.trim()
                ? `\n\n## 当前上下文\n\n${args.userRequest.trim()}\n`
                : '';

            return {
                description: REUSABLE_CODE_ADVISOR_DESCRIPTION,
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: `${REUSABLE_CODE_ADVISOR_MARKDOWN}${suffix}`,
                        },
                    },
                ],
            };
        }
    );
}
