# Code Intelligence MCP (Minimal)

- MCP Server（stdio）
- Tool: `search_symbols`
- Tool: `get_symbol_detail`
- Tool: `search_by_structure`
- Tool: `reindex`
- Tool: `recommend_component`
- Tool: `incUsage`
- Prompt: `reusable-code-advisor`
- MySQL Repository（可选启用）
- Cursor Skill：`reusable-code-advisor`（`.cursor/skills/reusable-code-advisor/`，

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

```
    - uses: lorrylurui/code-intelligence-check@v1
```

## 3) 项目根目录环境变量

MYSQL\*SYMBOLS_TABLE=frontend_collections_symbols
INDEX_GLOB=interview-code-collection/\*\*/\_.{js,jsx,ts,tsx}
