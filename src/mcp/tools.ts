import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";

/**
 * Register CodeTeleport MCP tools on the server.
 * Tools: teleport_push, teleport_pull, teleport_list, teleport_status, teleport_delete
 */
export function registerTools(_server: McpServer): void {
	throw new Error("not implemented");
}
