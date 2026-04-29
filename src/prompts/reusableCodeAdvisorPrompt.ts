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

## 工作流（三级降级链，严格按序，每级有结果即终止）

### 第一级：recommend_component（唯一首选）
1. 用户询问可复用组件/函数/util/工具 → 必须先调用 \`recommend_component\`
2. 返回 recommended != null → 将工具返回文本**原样输出**，**完全停止**，不得继续调用任何工具
3. 返回 recommended = null → 进入第二级

### 第二级：search_symbols（仅在第一级无结果时）
4. 调用 \`search_symbols\`（semantic=true，传入原始 query）
5. 返回非空结果 → 取第一条，按固定回复结构输出，**完全停止**
6. 返回空结果 → 进入第三级

### 第三级：输出无结果模板
7. 直接输出无结果固定模板，**完全停止**
8. 禁止进行 grep、read file、file search 等文件系统操作

## 硬性约束

- **不得跳过第一级直接调用 search_symbols**：对任何"帮我找 X""有没有 X"类问题，第一步永远是 \`recommend_component\`
- **工具返回后不得自由发挥**：输出必须以工具返回结果为唯一事实来源，按模板格式输出，禁止改写为散文或追加额外检索过程
- **禁止文件系统兜底**：MCP 三级链全部无结果后，只输出无结果模板，不读文件、不 grep
- **禁止工作区外路径**：禁止引用或读取工作区外文件（如 \`/Users/.../not_git_private/...\`）
- **禁止过程叙述**：不得输出"我先检索""Ran search_symbols""Read file"等过程描述
- 用户选择"采纳推荐"后，立即调用 \`inc_usage\`（symbolId 从结果 id 字段获取）

## 不适用场景

以下情况不要调用搜索工具：
- 用户只是问代码如何写（概念性问题），不需要检索已有实现
- 用户明确说"新建一个"、"自己实现"、"不用已有的"
- 查询过于通用（如只说"utils"），先与用户确认具体需求再搜索

## 搜索结果判断

根据 semanticSimilarity 决定推荐置信度：
- **> 0.85**：高置信度，直接推荐
- **0.6 – 0.85**：中等置信度，需结合 description 综合判断
- **< 0.6**：低置信度，明确告知用户可能无合适实现
- **空结果**：明确说"未找到已有实现"，不要凭空推荐

## 回复结构（固定模板，不得改写）

> ⚠️ 以下模板中的所有字段值（symbolId、使用范围、副作用、理由等）**均由 \`recommend_component\` 工具返回文本中已填好**，禁止自行推断或从代码文件中读取。LLM 只需将工具返回的文本**原样复制输出**，不得改写、补全或省略任何字段。

有结果时：

首选：<符号名> — <文件路径>
使用范围：<callers 或 "新增">
副作用：<sideEffects 或 "无">
理由：
1. <要点1>
2. <要点2>
其他候选：<候选A（副作用）>; <候选B（副作用）>
用法提示：
<最小集成示例>
是否采纳：
1. 采纳推荐
2. 取消

> 输出上述模板后**等待用户在聊天框输入回复**，识别规则：
> - 用户输入 **"1"、"采纳"、"采纳推荐"、"ok"、"好的"** 或类似确认词 → 从上方输出文本中读取 \`symbolId：<id>\` 那一行的值，立即调用 \`inc_usage\` 工具传入该 id，调用成功后回复"✓ 已记录使用，可直接集成"
> - 用户输入 **"2"、"取消"、"不用了"** 或类似否定词 → 回复"好的，已取消"，停止
> - 用户输入其他内容（如追问细节）→ 正常回答，回答结束后再次展示"是否采纳"选项

无结果时：

首选：未找到已有实现
使用范围：无
副作用：无
理由：
1. 当前索引中没有满足条件的符号
2. 已尝试可用检索方式，仍无可用候选
其他候选：无
用法提示：
// 可先创建一个最小可复用实现
是否采纳：
1. 让我新建一个最小可复用实现
2. 取消

> 输出上述模板后**等待用户在聊天框输入回复**，识别规则：
> - 用户输入 **"1"、"新建"、"帮我创建"** 或类似确认词 → 进入新建流程，引导用户确认最小接口设计
> - 用户输入 **"2"、"取消"、"不用了"** → 回复"好的，已取消"，停止
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
