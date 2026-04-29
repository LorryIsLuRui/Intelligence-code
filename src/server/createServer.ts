import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerReusableCodeAdvisorPrompt } from '../prompts/reusableCodeAdvisorPrompt.js';
import { SymbolRepository } from '../repositories/symbolRepository.js';
import { createSearchSymbolsTool } from '../tools/searchSymbols.js';
import { createGetSymbolDetailTool } from '../tools/getSymbolDetail.js';
import { createReindexTool } from '../tools/reindex.js';
import { createSearchByStructureTool } from '../tools/searchByStructure.js';
import { createIncUsageTool } from '../tools/incUsage.js';
import { RecommendationService } from '../services/recommendationService.js';
import { createRecommendComponentTool } from '../tools/recommendComponent.js';

export function createServer() {
    console.error('[code-intelligence-mcp] createServer.init');

    const server = new McpServer({
        name: 'code-intelligence-mcp',
        version: '0.1.0',
    });
    console.error(
        '[code-intelligence-mcp] mcpServer.created name=code-intelligence-mcp version=0.1.0'
    );

    const repository = new SymbolRepository();
    console.error('[code-intelligence-mcp] repository.created');

    const recommendationService = new RecommendationService(repository);
    console.error('[code-intelligence-mcp] recommendationService.created');

    const searchTool = createSearchSymbolsTool(repository);
    server.tool(
        searchTool.name,
        searchTool.description,
        searchTool.inputSchema,
        searchTool.handler
    );
    console.error(
        '[code-intelligence-mcp] tool.registered %s',
        searchTool.name
    );

    const detailTool = createGetSymbolDetailTool(repository);
    server.tool(
        detailTool.name,
        detailTool.description,
        detailTool.inputSchema,
        detailTool.handler
    );
    console.error(
        '[code-intelligence-mcp] tool.registered %s',
        detailTool.name
    );

    const structureTool = createSearchByStructureTool(repository);
    server.tool(
        structureTool.name,
        structureTool.description,
        structureTool.inputSchema,
        structureTool.handler
    );
    console.error(
        '[code-intelligence-mcp] tool.registered %s',
        structureTool.name
    );

    const reindexTool = createReindexTool();
    server.tool(
        reindexTool.name,
        reindexTool.description,
        reindexTool.inputSchema,
        reindexTool.handler
    );
    console.error(
        '[code-intelligence-mcp] tool.registered %s',
        reindexTool.name
    );

    const incUsageTool = createIncUsageTool(repository);
    server.tool(
        incUsageTool.name,
        incUsageTool.description,
        incUsageTool.inputSchema,
        incUsageTool.handler
    );
    console.error(
        '[code-intelligence-mcp] tool.registered %s',
        incUsageTool.name
    );

    const recommendComponentTool = createRecommendComponentTool(
        recommendationService
    );
    server.tool(
        recommendComponentTool.name,
        recommendComponentTool.description,
        recommendComponentTool.inputSchema,
        recommendComponentTool.handler
    );
    console.error(
        '[code-intelligence-mcp] tool.registered %s',
        recommendComponentTool.name
    );

    registerReusableCodeAdvisorPrompt(server);
    console.error(
        '[code-intelligence-mcp] prompt.registered reusable-code-advisor'
    );

    console.error(
        '[code-intelligence-mcp] createServer.ready toolCount=6 promptCount=1'
    );

    return server;
}
