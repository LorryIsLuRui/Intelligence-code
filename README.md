# Code Intelligence MCP

- MCP Server（stdio）
- Tool: `search_symbols`
- Tool: `get_symbol_detail`
- Tool: `search_by_structure`
- Tool: `recommend_component`
- Tool: `reindex`
- Tool: `incUsage`
- Prompt: `reusable-code-advisor`
- Cursor Skill：`reusable-code-advisor`（`.cursor/skills/reusable-code-advisor/`，

## 开发

```
    1. npm run dev:mcp 启动mcp  server
    2. npm run embedding:dev 启动本地python环境
    3. npm run worker:embedding 启动worker队列
```

## 1) 配置mcp servers

```
{
  "mcpServers": {
    "code-intelligence-mcp": {
      "command": "npx",
      "args": ["-y", "@lorrylurui/code-intelligence-mcp"]
    }
  }
}
```

## 2)配置流水线

```yml
    - uses: LorryIsLuRui/code-intelligence-ci-index@v1
    with:
        symbols-table: ${{ inputs.symbols-table }}
```

## 3) 项目根目录环境变量

<!-- 最小配置 1.表名 2.需要检索的文件路径和类型 -->

MYSQL\*SYMBOLS_TABLE=frontend_collections_symbols
INDEX_GLOB=xxx/\*\*/\_.{js,jsx,ts,tsx}

## 4) 离线测评

```javascript
npx tsx src/cli/eval-recommendation-cli.ts
# 或指定 limit
npx tsx src/cli/eval-recommendation-cli.ts --limit 10

npm run eval
```

## 5）分析离线测评结果

```javascript
npm run analyze                                          # 自动读最新结果文件
npm run analyze -- offline_eval/results/2026-05-27.jsonl  # 指定文件
npm run analyze -- --baseline offline_eval/results/2026-05-26.jsonl  # 与 baseline 对比 delta

```

或者直接引用eval-analysis.prompt.md 对最新结果分析
