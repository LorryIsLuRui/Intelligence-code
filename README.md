# Code Intelligence MCP (Minimal)

最小可用的 Node MCP Server 框架，包含：

- MCP Server（stdio）
- Tool: `search_symbols`
- Tool: `get_symbol_detail`
- MySQL Repository（可选启用）
- Skill 占位：`recommendComponent`

## 1) 安装

```bash
npm install
```

## 2) 环境变量

复制 `.env.example` 为 `.env`。

默认不强制连接 MySQL（未配置时走内存示例数据）。

如果你要连接 MySQL，请设置：

```env
MYSQL_ENABLED=true
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=code_intelligence
```

## 3) 初始化数据库（可选）

```bash
mysql -u root -p code_intelligence < sql/schema.sql
```

## 4) 本地运行

### 普通开发（热更新）

```bash
npm run dev
```

使用 `tsx watch`，改 `src/` 会自动重启；已关闭清屏（`--clear-screen=false`），并排除 `node_modules`、`dist`。

### 接 Cursor MCP（不污染 stdout）

MCP 走 **stdio**，协议数据必须在子进程的 **stdout** 上；若用 `npm run dev` 接 MCP，`npm` 或部分工具可能往 stdout 打杂讯，导致握手异常。

推荐用 **专用脚本**：子进程只跑 `tsx src/index.ts`，**监听/重启日志只打到 stderr**。

```bash
npm run dev:mcp
```

**Cursor `mcp.json` 示例（推荐直接调 node，避免 npm）：**

```json
{
  "mcpServers": {
    "code-intelligence-mcp": {
      "command": "node",
      "args": ["/绝对路径/Intelligence-code/scripts/mcp-dev-watch.mjs"],
      "cwd": "/绝对路径/Intelligence-code"
    }
  }
}
```

也可继续用 `"command": "npm"`, `"args": ["run", "dev:mcp"]`，但部分环境下 npm 仍可能产生额外输出；若 tools 不稳定，请改用上面的 `node .../mcp-dev-watch.mjs`。

## 5) 后续演进建议

- 加入 Indexer（`ts-morph` + `fast-glob`）
- 新增 Tool：`search_by_structure`、`list_dependencies`、`get_usage_stats`
- Skill 层引入完整推荐流程
- 增加 Python embedding 服务（语义检索）



