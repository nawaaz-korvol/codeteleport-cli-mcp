#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { registerTools } from "./tools";

const server = new McpServer({
	name: "codeteleport",
	version: "0.1.0",
});

registerTools(server);

const transport = new StdioServerTransport();
server.connect(transport);
