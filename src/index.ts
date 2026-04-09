#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadProjectDotenv } from './config/env.js';
import { createServer } from './server/createServer.js';

async function main() {
    // 加载第三方项目的 .env（通过 INDEX_ROOT 指定，或默认当前工作目录）
    const projectRoot = process.env.INDEX_ROOT || process.cwd();
    loadProjectDotenv(projectRoot);

    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error) => {
    console.error('MCP 服务启动失败：', error);
    process.exit(1);
});
