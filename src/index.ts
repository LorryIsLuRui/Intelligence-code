#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { validateEnv } from './config/env.js';
import { createServer } from './server/createServer.js';

async function main() {
    validateEnv();

    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error) => {
    console.error('MCP 服务启动失败：', error);
    process.exit(1);
});
