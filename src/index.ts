import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { validateEnv } from "./config/env.js";
import { createServer } from "./server/createServer.js";

async function main() {
  validateEnv();

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});
