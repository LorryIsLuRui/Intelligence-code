import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const DESCRIPTION = "使用 recommend_component 流程推荐最合适的可复用组件候选。";

export function registerRecommendComponentPrompt(server: McpServer): void {
  server.prompt(
    "recommend-component",
    DESCRIPTION,
    {
      requirement: z.string().describe("用户需求描述，例如：带校验的表单组件"),
      props: z
        .array(z.string())
        .optional()
        .describe("结构过滤所需的可选 props，例如 onChange,value")
    },
    async (args) => {
      const propsHint = args.props?.length
        ? `\n并传入 props 参数：${JSON.stringify(args.props)}`
        : "";

      return {
        description: DESCRIPTION,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `你正在执行 Phase 4 的 skill 验证流程。\n` +
                `1）调用 recommend_component，query 参数为：${JSON.stringify(args.requirement)}。${propsHint}\n` +
                `2）返回 Top 结果，并给出 score、reason 以及使用建议。\n` +
                `3）如果没有结果，请明确说明缺口，并给出最接近的候选项。`
            }
          }
        ]
      };
    }
  );
}
