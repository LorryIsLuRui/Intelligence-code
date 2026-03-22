import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReusableCodeAdvisorPrompt } from "../prompts/reusableCodeAdvisorPrompt.js";
import { SymbolRepository } from "../repositories/symbolRepository.js";
import { createSearchSymbolsTool } from "../tools/searchSymbols.js";
import { createGetSymbolDetailTool } from "../tools/getSymbolDetail.js";

export function createServer() {
  const server = new McpServer({
    name: "code-intelligence-mcp",
    version: "0.1.0"
  });

  const repository = new SymbolRepository();

  const searchTool = createSearchSymbolsTool(repository);
  server.tool(searchTool.name, searchTool.description, searchTool.inputSchema, searchTool.handler);

  const detailTool = createGetSymbolDetailTool(repository);
  server.tool(detailTool.name, detailTool.description, detailTool.inputSchema, detailTool.handler);

  registerReusableCodeAdvisorPrompt(server);

  return server;
}
