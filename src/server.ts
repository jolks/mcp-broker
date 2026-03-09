import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Broker, type ToolInvocation, type ServerUpdate } from "./broker.js";
import { logger } from "./logger.js";
import { VERSION, SERVER_NAME, DEFAULT_SEARCH_LIMIT, getErrorMessage } from "./config.js";

// ── Meta-tool definitions (always visible) ─────────────

export const META_TOOLS: Tool[] = [
  {
    name: "search_tools",
    description:
      "ALWAYS call this FIRST before attempting any task. " +
      "Searches all connected MCP servers for relevant tools. " +
      "Returns tool names, descriptions, and input schemas. " +
      "Use call_tools with the server_name and tool_name from results to invoke a tool.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural language search query (e.g., 'create github issue', 'read file', 'send email')",
        },
        limit: {
          type: "number",
          description: `Maximum number of results (default: ${DEFAULT_SEARCH_LIMIT})`,
        },
      },
      required: ["query"],
    },
    annotations: { title: "Search Available Tools", readOnlyHint: true },
  },
  {
    name: "add_mcp_server",
    description:
      "Register a new MCP server. The server will be connected, its tools harvested and indexed for search.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Unique name for this server (e.g., 'github', 'filesystem')" },
        command: { type: "string", description: "Command to launch the server (e.g., 'npx')" },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Command arguments (e.g., ['@modelcontextprotocol/server-github'])",
        },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Environment variables (e.g., { GITHUB_TOKEN: '...' })",
        },
      },
      required: ["name", "command"],
    },
    annotations: { idempotentHint: true },
  },
  {
    name: "remove_mcp_server",
    description: "Remove a registered MCP server and all its indexed tools.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Name of the server to remove" },
      },
      required: ["name"],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "list_mcp_servers",
    description:
      "List all registered MCP servers with connection status and tool counts. " +
      "Use when search_tools returns no results to see what servers are available, then refine your search query.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    annotations: { title: "List Servers", readOnlyHint: true },
  },
  {
    name: "get_mcp_server",
    description:
      "Get detailed info for a server including all its tool names. " +
      "Use to see what tools a specific server offers, then call search_tools with better keywords.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Name of the server to inspect" },
      },
      required: ["name"],
    },
    annotations: { title: "Server Details", readOnlyHint: true },
  },
  {
    name: "update_mcp_server",
    description:
      "Update a registered MCP server's configuration. Only provided fields are changed. " +
      "If command/args/env change, the server is re-harvested and reconnected.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Name of the server to update" },
        command: { type: "string", description: "New command to launch the server" },
        args: {
          type: "array",
          items: { type: "string" },
          description: "New command arguments",
        },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "New environment variables (replaces all existing env vars)",
        },
      },
      required: ["name"],
    },
    annotations: { idempotentHint: true },
  },
  {
    name: "refresh_tools",
    description:
      "Re-harvest tools from one or all MCP servers. Use after a server has been updated with new tools.",
    inputSchema: {
      type: "object" as const,
      properties: {
        server_name: {
          type: "string",
          description: "Specific server to refresh (omit to refresh all)",
        },
      },
    },
    annotations: { idempotentHint: true },
  },
  {
    name: "call_tools",
    description:
      "Call tools discovered via search_tools. " +
      "You MUST call search_tools first — tool names and schemas come from search results. " +
      "Pass an array of invocations executed in parallel.",
    inputSchema: {
      type: "object" as const,
      properties: {
        invocations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              server_name: { type: "string", description: "Server name from search results" },
              tool_name: { type: "string", description: "Tool name from search results" },
              arguments: { type: "object", description: "Arguments for the tool (see input_schema from search results)" },
            },
            required: ["server_name", "tool_name"],
          },
          description: "Array of tool invocations to execute in parallel",
        },
      },
      required: ["invocations"],
    },
    annotations: { title: "Invoke Tools", openWorldHint: true },
  },
];

const META_TOOL_NAMES = new Set(META_TOOLS.map((t) => t.name));

// ── Dynamic description builder ──────────────────────────

export function buildDynamicTools(
  servers: Array<{ name: string; toolCount: number }>
): Tool[] {
  const totalTools = servers.reduce((sum, s) => sum + s.toolCount, 0);

  return META_TOOLS.map((t) => {
    if (t.name !== "search_tools" || servers.length === 0) return t;

    const MAX_LISTED = 10;
    const names = servers.map((s) => s.name);
    const serverNames =
      names.length <= MAX_LISTED
        ? names.join(", ")
        : names.slice(0, MAX_LISTED).join(", ") + `, and ${names.length - MAX_LISTED} more`;

    return {
      ...t,
      description:
        `ALWAYS call this FIRST. This gateway provides access to ${totalTools} tools ` +
        `across ${servers.length} server(s) (${serverNames}). ` +
        "Search by keyword to discover tools, then use call_tools to invoke them.",
    };
  });
}

// ── Server setup ───────────────────────────────────────

export async function startServer(broker: Broker): Promise<Server> {
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        "mcp-broker is a tool gateway that provides access to tools from many other MCP servers. " +
        "You do NOT have direct access to those tools — you must first discover them.\n\n" +
        "WORKFLOW:\n" +
        "1. ALWAYS call search_tools first to find relevant tools for the user's request.\n" +
        "2. search_tools returns tool names and schemas. Use call_tools to invoke a discovered tool.\n" +
        "3. Pass server_name, tool_name, and arguments from the search results to call_tools.\n\n" +
        "IMPORTANT: Do not guess tool names. Always search first.",
    }
  );

  // ── tools/list handler ─────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.info(`tools/list called (${META_TOOLS.length} meta-tools)`);
    const tools = buildDynamicTools(broker.listServers());
    return { tools };
  });

  // ── tools/call handler ─────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (!META_TOOL_NAMES.has(name)) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    return handleMetaTool(broker, name, args ?? {});
  });

  // ── Connect transport ──────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("mcp-broker server started on stdio");

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    await broker.shutdown();
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}

// ── Meta-tool implementations ──────────────────────────

export async function handleMetaTool(
  broker: Broker,
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  switch (name) {
    case "search_tools": {
      const query = args.query as string;
      if (!query) {
        return { content: [{ type: "text", text: "Error: 'query' is required" }], isError: true };
      }
      const limit = args.limit as number | undefined;
      const results = broker.searchTools(query, limit);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No tools found matching "${query}". Try different keywords, or call list_mcp_servers to browse available servers.`,
            },
          ],
        };
      }

      // Build response with schemas so the LLM can use call_tools
      const lines = results.map((t, i) => {
        const schema = t.input_schema as Record<string, unknown>;
        const props = schema.properties ? JSON.stringify(schema.properties) : "{}";
        return `${i + 1}. ${t.server_name} / ${t.tool_name} — ${t.description}\n   Input: ${props}`;
      });

      return {
        content: [
          {
            type: "text",
            text:
              `Found ${results.length} tool(s) matching "${query}":\n\n` +
              lines.join("\n\n") +
              "\n\nUse call_tools with the server_name and tool_name to invoke a tool.",
          },
        ],
      };
    }

    case "add_mcp_server": {
      const serverName = args.name as string;
      const command = args.command as string;
      if (!serverName || !command) {
        return {
          content: [{ type: "text", text: "Error: 'name' and 'command' are required" }],
          isError: true,
        };
      }
      try {
        const { toolCount } = await broker.addServer({
          name: serverName,
          command,
          args: (args.args as string[]) ?? [],
          env: args.env as Record<string, string> | undefined,
        });
        return {
          content: [
            {
              type: "text",
              text: `Added server "${serverName}" with ${toolCount} tools.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to add server "${serverName}": ${getErrorMessage(err)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "remove_mcp_server": {
      const serverName = args.name as string;
      if (!serverName) {
        return { content: [{ type: "text", text: "Error: 'name' is required" }], isError: true };
      }
      await broker.removeServer(serverName);
      return {
        content: [{ type: "text", text: `Removed server "${serverName}" and all its tools.` }],
      };
    }

    case "list_mcp_servers": {
      const servers = broker.listServers();
      if (servers.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No servers registered. Use add_mcp_server or run `mcp-broker import <config-path>` to add servers.",
            },
          ],
        };
      }
      const lines = servers.map(
        (s) => `- **${s.name}**: ${s.toolCount} tools | ${s.connected ? "connected" : "disconnected"}`
      );
      return {
        content: [
          {
            type: "text",
            text: lines.join("\n") + "\n\nTo find and call specific tools, use search_tools with a keyword.",
          },
        ],
      };
    }

    case "get_mcp_server": {
      const serverName = args.name as string;
      if (!serverName) {
        return { content: [{ type: "text", text: "Error: 'name' is required" }], isError: true };
      }
      const server = broker.getServer(serverName);
      if (!server) {
        return {
          content: [{ type: "text", text: `Server "${serverName}" not found.` }],
          isError: true,
        };
      }

      const envKeys = server.env ? Object.keys(server.env) : [];
      const lines = [
        `**${server.name}**`,
        `- Command: \`${server.command}\``,
        `- Args: ${server.args.length > 0 ? server.args.map((a) => `\`${a}\``).join(", ") : "(none)"}`,
        `- Env vars: ${envKeys.length > 0 ? envKeys.join(", ") : "(none)"}`,
      ];
      if (server.version) {
        lines.push(`- Version: ${server.version}`);
      }
      lines.push(
        `- Status: ${server.connected ? "connected" : "disconnected"}`,
        `- Tools (${server.toolCount}):`,
      );
      if (server.tools.length > 0) {
        for (const t of server.tools) {
          lines.push(`  - ${t.tool_name}: ${t.description}`);
        }
      } else {
        lines.push("  (no tools indexed)");
      }
      return {
        content: [
          {
            type: "text",
            text:
              lines.join("\n") +
              "\n\nUse search_tools with a tool name above to get its input schema, then call_tools to invoke it.",
          },
        ],
      };
    }

    case "update_mcp_server": {
      const serverName = args.name as string;
      if (!serverName) {
        return { content: [{ type: "text", text: "Error: 'name' is required" }], isError: true };
      }

      const updates: ServerUpdate = {};
      let hasUpdates = false;
      if (args.command !== undefined) { updates.command = args.command as string; hasUpdates = true; }
      if (args.args !== undefined) { updates.args = args.args as string[]; hasUpdates = true; }
      if (args.env !== undefined) { updates.env = args.env as Record<string, string>; hasUpdates = true; }

      if (!hasUpdates) {
        return {
          content: [{ type: "text", text: "Error: at least one field (command, args, env) must be provided" }],
          isError: true,
        };
      }

      try {
        const { toolCount } = await broker.updateServer(serverName, updates);
        const changedFields = Object.keys(updates).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Updated server "${serverName}" (changed: ${changedFields}). ${toolCount} tools indexed.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to update server "${serverName}": ${getErrorMessage(err)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "refresh_tools": {
      const serverName = args.server_name as string | undefined;
      await broker.refreshTools(serverName);
      return {
        content: [
          {
            type: "text",
            text: serverName
              ? `Refreshed tools for "${serverName}".`
              : "Refreshed tools for all servers.",
          },
        ],
      };
    }

    case "call_tools": {
      // Accept both {invocations: [...]} and flat {server_name, tool_name, arguments}
      let invocations = args.invocations as ToolInvocation[] | undefined;
      if (!Array.isArray(invocations) && typeof args.server_name === "string" && typeof args.tool_name === "string") {
        invocations = [{ server_name: args.server_name as string, tool_name: args.tool_name as string, arguments: args.arguments as Record<string, unknown> }];
      }
      if (!Array.isArray(invocations) || invocations.length === 0) {
        return {
          content: [{ type: "text", text: "Error: 'invocations' must be a non-empty array" }],
          isError: true,
        };
      }
      return broker.callTools(invocations);
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
}
