# VS Code Migration Guide (MCP Server)

本文档说明如何把当前项目的 MCP Server 从 Cursor 使用方式迁移到 VS Code。

## 目标与结论

- 你的 MCP Server 是标准 `stdio` 进程模型（`@modelcontextprotocol/sdk`），可以迁移到 VS Code 生态。
- 需要迁移的是「客户端配置」而不是服务端核心代码。
- `.cursor/skills/...` 是 Cursor 私有能力，迁移到 VS Code 后需要改用：
  - MCP Prompt（你已经实现了 `reusable-code-advisor`）
  - 或在 VS Code 侧的 system prompt / instruction 中复写同样流程

## 先决条件

1. Node.js 18+（建议 20+）
2. 项目依赖已安装：

```bash
npm install
npm run build
```

3. MySQL 可用（本项目 `search_symbols` 在 `MYSQL_ENABLED=true` 时会走数据库）
4. `.env` 已配置（可参考 `.env.example`）

## 第 1 步：确认服务本地可运行

先确保服务进程可单独启动：

```bash
npm run dev:mcp
```

若要稳定用于外部客户端，建议使用编译产物：

```bash
npm run build
node dist/index.js
```

> 说明：MCP 使用 `stdio`，不要在服务端向 `stdout` 打普通日志（会污染协议流）。调试日志应写 `stderr`。

## 第 2 步：在 VS Code 选择 MCP 客户端

VS Code 本体不直接消费你这个 Node 进程，需要一个支持 MCP 的聊天/Agent 扩展（例如 Cline / Continue 或其他支持 MCP 的扩展）。

不同扩展配置文件不同，但核心字段都一致：

- `command`: 启动命令
- `args`: 命令参数
- `cwd`: 项目目录
- `env`: 环境变量（可选）

下面给一个通用模板（按你所用扩展改字段名）：

```json
{
  "mcpServers": {
    "code-intelligence-mcp": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/Intelligence-code/dist/index.js"],
      "cwd": "/ABSOLUTE/PATH/Intelligence-code",
      "env": {
        "MYSQL_ENABLED": "true",
        "MYSQL_HOST": "127.0.0.1",
        "MYSQL_PORT": "3306",
        "MYSQL_USER": "root",
        "MYSQL_PASSWORD": "devpassword",
        "MYSQL_DATABASE": "code_intelligence"
      }
    }
  }
}
```

开发态也可用：

```json
{
  "command": "node",
  "args": ["/ABSOLUTE/PATH/Intelligence-code/scripts/mcp-dev-watch.mjs"],
  "cwd": "/ABSOLUTE/PATH/Intelligence-code"
}
```

## 第 3 步：验证 Tools / Prompts

迁移成功后，至少验证以下能力：

1. `list_tools` 能看到：
   - `search_symbols`
   - `get_symbol_detail`
2. `list_prompts` 能看到：
   - `reusable-code-advisor`
3. 调用用例：
   - `search_symbols` with `{"query":"form","type":"component"}`
   - `get_symbol_detail` with `{"name":"FormInput"}`

## 第 4 步：处理 Cursor Skill 差异

当前仓库的 `.cursor/skills/reusable-code-advisor/SKILL.md` 不会被 VS Code 自动读取。

你有两种方式保持行为一致：

1. 优先使用 MCP Prompt：`reusable-code-advisor`
2. 把 SKILL 工作流拷贝到 VS Code 扩展的系统指令中

推荐做法：继续以 MCP Prompt 作为跨客户端统一入口，减少双维护。

## 第 5 步：数据库与索引迁移

VS Code 迁移本身不改变数据库流程，仍按以下步骤：

1. 启动 MySQL（本地或 Docker）
2. 初始化 schema（首次）
3. 执行：

```bash
npm run index
```

如遇 `ECONNREFUSED 127.0.0.1:3306`，说明 MySQL 未启动或端口不对。

## 常见问题

### 1) 在 VS Code 里看不到 tools

- 配置文件路径错 / 字段名不符扩展规范
- `cwd` 不正确，导致无法找到 `dist/index.js`
- `node` 路径不在 VS Code 进程环境的 PATH

### 2) 能连上但调用失败

- 服务端 `stdout` 有杂讯日志
- `.env` 未加载（可直接在 MCP 配置里用 `env` 显式传）
- MySQL 不可达或鉴权失败

### 3) Docker 安装失败（你当前遇到过下载中断）

- 先不阻塞迁移：可直接连接已有 MySQL（本机或远程）
- 或重试 Docker Desktop 下载，网络稳定后再用 `docker compose up -d`

## 推荐上线方式

如果你准备长期在 VS Code 使用，建议：

1. 优先使用 `dist/index.js`（更稳定）
2. 把 MCP 配置纳入团队文档（不提交个人密码）
3. 用 `.env.example` 提供可复制模板
4. 对 `index` 与两个 tool 增加最小回归测试（后续可加）
