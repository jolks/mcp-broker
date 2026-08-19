#!/usr/bin/env node

/**
 * Minimal MCP server fixture for testing harvester and pool.
 * Exposes two tools: "echo" (returns input) and "add" (returns sum).
 *
 * Usage: npx tsx tests/fixtures/echo-server.ts
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "echo-server", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Returns the input message as-is",
      inputSchema: {
        type: "object" as const,
        properties: {
          message: { type: "string", description: "Message to echo" },
        },
        required: ["message"],
      },
    },
    {
      name: "add",
      description: "Returns the sum of two numbers",
      inputSchema: {
        type: "object" as const,
        properties: {
          a: { type: "number", description: "First number" },
          b: { type: "number", description: "Second number" },
        },
        required: ["a", "b"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "echo":
      return {
        content: [{ type: "text", text: `Echo: ${(args?.message as string) ?? ""}` }],
      };
    case "add": {
      const sum = ((args?.a as number) ?? 0) + ((args?.b as number) ?? 0);
      return {
        content: [{ type: "text", text: String(sum) }],
      };
    }
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`echo-server error: ${err}\n`);
  process.exit(1);
});
