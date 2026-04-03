# Code Intelligence MCP (Minimal)

最小可用的 Node MCP Server 框架，包含：

- MCP Server（stdio）
- Tool: `search_symbols`（支持 `semantic=true` 语义检索，Phase 5）
- Tool: `get_symbol_detail`
- Tool: `search_by_structure`
- Tool: `reindex`
- Tool: `recommend_component`
- Prompt: `reusable-code-advisor`（与 Cursor Skill 同工作流，见 `src/prompts/reusableCodeAdvisorPrompt.ts`）
- MySQL Repository（可选启用）
- Cursor Skill：`reusable-code-advisor`（`.cursor/skills/reusable-code-advisor/`，未改动，与 MCP Prompt 并行维护）

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
MYSQL_PASSWORD=devpassword
MYSQL_DATABASE=code_intelligence

# Phase 5（可选）：句向量服务根 URL，与 `npm run embedding:dev` 默认端口一致
# EMBEDDING_SERVICE_URL=http://127.0.0.1:8765
```

密码需与下方 Docker / 本机 MySQL 配置一致（文档示例里 `devpassword` 对应 Compose）。

### 用 Docker 启动 MySQL（推荐本地开发）

1. 安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)（或 Docker Engine + Compose 插件）。
2. 在项目根目录执行：

```bash
npm run docker:up
# 或：docker compose up -d
```

3. 首次启动会自动挂载 `sql/schema.sql` 到 `docker-entrypoint-initdb.d`，**创建库表**（仅**空数据卷**时执行一次）。
4. 复制 `.env.example` 为 `.env`，设置 `MYSQL_ENABLED=true`，`MYSQL_PASSWORD` 与 `docker-compose.yml` 里 `MYSQL_ROOT_PASSWORD`（默认 `devpassword`）一致。
5. 等待容器健康（约数十秒）：

```bash
docker compose ps
```

6. 再执行 `npm run index` 或启动 MCP。

常用命令：

| 命令                     | 说明                           |
| ------------------------ | ------------------------------ |
| `npm run docker:logs`    | 查看 MySQL 日志                |
| `npm run docker:down`    | 停止容器（数据卷保留，库仍在） |
| `docker compose down -v` | **删除卷**（清空库，慎用）     |

**端口冲突**：若本机已有服务占用 `3306`，把 `docker-compose.yml` 里 `ports` 改为 `"3307:3306"`，并在 `.env` 设 `MYSQL_PORT=3307`。

## 3) 初始化数据库（可选）

- **已用上述 Docker 首次启动**：若卷为空，建表已由 `sql/schema.sql` 自动执行，一般无需再跑下面命令。
- **本机 mysql 客户端 / 手动执行**：

```bash
mysql -u root -p code_intelligence < sql/schema.sql
```

### 自定义表名（第三方项目集成）

若需使用不同的表名，可通过环境变量配置：

```bash
# 设置自定义表名
export MYSQL_SYMBOLS_TABLE=my_project_symbols

# 然后server代码内部执行建表（表名会在代码中动态替换）
mysql -u root -p code_intelligence -e "$(node -e \"import('./dist/db/schema.js').then(m => console.log(m.getSymbolsTableSQL()))\")"
```

或在 `.env` 中配置：

```env
MYSQL_SYMBOLS_TABLE=my_project_symbols
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

### MCP Prompt（非 Cursor 客户端）

服务器注册 Prompt **`reusable-code-advisor`**：客户端执行 `prompts/list` 可见；`prompts/get` 时可传可选参数 **`userRequest`**（用户当前需求或关键词），返回的消息正文与 Cursor Skill 工作流一致。  
文案与 `.cursor/skills/reusable-code-advisor/SKILL.md` 正文需**手动同步**（见 `src/prompts/reusableCodeAdvisorPrompt.ts` 顶部注释）。

在 **MCP Inspector** 中切换到 **Prompts** 面板即可选择并调试。

## 5) Phase 2：代码索引（ts-morph + fast-glob → MySQL）

1. **建表 / 迁移**
    - 新库：执行 `sql/schema.sql`（已含 `(path, name)` 唯一索引，便于重复执行 `npm run index` 时 upsert）。
    - 旧库若只有早期表结构：执行 `sql/migrations/002_symbols_unique_path_name.sql`（若已有重复 `path+name` 需先清理）。

2. **配置 MySQL**（`.env` 中 `MYSQL_ENABLED=true` 等）。

3. **跑索引**（日志在 stderr，不污染 MCP stdout）：

```bash
npm run index
```

可选环境变量（见 `.env.example`）：

| 变量           | 含义                                             |
| -------------- | ------------------------------------------------ |
| `INDEX_ROOT`   | 工程根目录，默认当前工作目录                     |
| `INDEX_GLOB`   | 空格分隔 glob，默认 `src/**/*.{ts,tsx}`         |
| `INDEX_IGNORE` | 额外忽略的 glob 片段（空格分隔）                 |

**分类规则（首版启发式）**：`interface` / `type` → `type`；`.tsx` 且函数体含 JSX → `component`；路径或导出名含 `selector` → `selector`；其余导出函数 → `util`；`class` → `util`（可后续细化）。

**常见错误 `ECONNREFUSED 127.0.0.1:3306`**：本机没有在该端口监听 MySQL。请先启动数据库服务（例如 macOS Homebrew：`brew services start mysql` / `mariadb`），或把 `.env` 里的 `MYSQL_HOST`、`MYSQL_PORT` 改成你实际使用的实例（含 Docker 映射端口）。索引脚本会先执行 `SELECT 1` 再扫描代码，避免库不可用时仍跑完解析。

## 6) 后续演进建议

- 新增 Tool：`list_dependencies`、`get_usage_stats`
- Indexer：更细的 selector 识别、`export default` 命名、类组件等
- Phase 5 语义检索已落地（见下文）；后续可换 pgvector / FAISS、更大模型

## 8) Phase 3（增强）

- `search_symbols` 已支持 `ranked` 参数（默认 `true`），返回 `score` 和 `reason`。
- 新增 `search_by_structure`，可按 `fields`（匹配 `meta.props/params/properties/hooks`）检索。
- 两个搜索 tool 的 ranking 已升级：除可读 `reason` 外，还返回结构化 `reasonDetail`（含各维度得分、权重和匹配方式），方便前端/Agent解释。

示例：

```json
{
    "fields": ["onChange", "value"],
    "type": "component",
    "limit": 10
}
```

`reindex` 示例（Inspector / Agent 可直接调用，不用回终端）：

```json
{
    "dryRun": false
}
```

可选参数：

- `projectRoot`: 指定索引根目录（默认 MCP 进程当前目录）
- `globPatterns`: 自定义扫描 glob 列表
- `ignore`: 额外忽略规则
- `dryRun`: `true` 时只扫描，不写 MySQL

## 9) Phase 4（Skill）

- 新增 Skill Tool：`recommend_component`
- 流程已落地：关键词搜索 -> 结构过滤（可选 `props`）-> ranking -> detail 补全 -> 返回 reason
- 新增 Prompt：`recommend-component`（用于在支持 MCP Prompt 的客户端快速触发该流程）

示例：

```json
{
    "query": "带校验的表单组件",
    "props": ["value", "onChange"],
    "limit": 3
}
```

## 10) Phase 5（语义检索，可选）

1. **迁移**：若库是在增加 `embedding` 列之前创建的，执行：

```bash
mysql -u root -p code_intelligence < sql/migrations/003_add_embedding.sql
```

2. **Python 依赖**（建议虚拟环境；首次运行会下载模型权重，体积约数百 MB）：

```bash
cd embedding-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

3. **启动嵌入服务**（默认 `127.0.0.1:8765`）：

```bash
npm run embedding:dev
```

4. **`.env`** 增加 `EMBEDDING_SERVICE_URL=http://127.0.0.1:8765`，再执行 **`npm run index`** 或 MCP **`reindex`**（`dryRun=false`）写入向量。未配置 URL 时与 Phase 2 行为一致，不写入 `embedding`。

5. **`search_symbols`**：传入 `semantic: true` 可做自然语言检索；可选 `limit`（默认 20）。返回中会含 `semanticSimilarity`（余弦相似度）。当前实现按 `usage_count` 取最多 3000 条有向量的候选再精排；超大规模仓库请改为 ANN。

环境变量 **`EMBEDDING_MODEL`**（仅 Python）：覆盖默认的 `all-MiniLM-L6-v2`。

## 7) VS Code 迁移

迁移步骤见 `docs/vscode-mcp-migration.md`。

# 使用说明

Run with:

````bash
- 脚本 cli 启动：npx code-intelligence-mcp（走mcp不执行）
- 给项目做索引，运行：npx code-intelligence-index, 项目根目录取配置或者cwd（重要，首次以及后续需要时执行：新项目必须执行一次建表）
---

### MCP 配置（核心）

```md
## MCP Config

```json
{
  "mcpServers": {
    "code-intelligence": {
      "command": "npx",
      "args": ["code-intelligence-mcp"]
    }
  }
}
---

### 支持的 Tools Prompts

```md
## Tools

- search_symbols
- get_symbol_detail
- search_by_structure
- recommend_component
- reindex

## Prompts

- recommend-component
- reusable-code-advisor
````
