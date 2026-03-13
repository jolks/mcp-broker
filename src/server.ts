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
import type { ServerRecord } from "./store.js";
import { logger } from "./logger.js";
import { VERSION, SERVER_NAME, DEFAULT_SEARCH_LIMIT, getErrorMessage } from "./config.js";

// ── Response helpers ────────────────────────────────────

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

// ── Meta-tool definitions (always visible) ─────────────

export const META_TOOLS: Tool[] = [
  {
    name: "search_tools",
    description:
      "ALWAYS call this FIRST before attempting any task. " +
      "Searches all connected MCP servers for relevant tools. " +
      "Returns tool names, descriptions, and input schemas. " +
      "Use call_tools with the server_name and tool_name from results to invoke them.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural language search query (e.g., 'create github issue', 'read file', 'send email')",
        },
        queries: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of search queries to run independently and merge results. " +
            "Use when you need tools for different aspects of a task.",
        },
      },
      required: [],
    },
    annotations: { title: "Search Available Tools", readOnlyHint: true },
  },
  {
    name: "add_mcp_server",
    description:
      "Register a new MCP server (stdio or URL-based). The server will be connected, its tools harvested and indexed for search. " +
      "Provide either command (stdio) or url (SSE/Streamable HTTP), not both.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Unique name for this server (e.g., 'github', 'filesystem')" },
        command: { type: "string", description: "Command to launch a stdio server (e.g., 'npx')" },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Command arguments (e.g., ['@modelcontextprotocol/server-github'])",
        },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Environment variables for stdio server (e.g., { GITHUB_TOKEN: '...' })",
        },
        url: { type: "string", description: "URL for SSE/Streamable HTTP server (e.g., 'https://mcp.example.com/sse')" },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "HTTP headers for URL-based server (e.g., { Authorization: 'Bearer ...' })",
        },
      },
      // Mutual exclusivity of command vs url is enforced at runtime in handleMetaTool
      required: ["name"],
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
      "If command/args/env/url/headers change, the server is re-harvested and reconnected.",
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
        url: { type: "string", description: "New URL for SSE/Streamable HTTP server" },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "New HTTP headers for URL-based server",
        },
      },
      required: ["name"],
    },
    annotations: { idempotentHint: true },
  },
  {
    name: "call_tools",
    description:
      "Call tools discovered via search_tools. " +
      "You MUST call search_tools first — tool names and schemas come from search results. " +
      "Pass an array of invocations (parallel by default). " +
      "Set sequential: true when steps must run in order and all arguments are known upfront.",
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
          description: "Array of tool invocations",
        },
        sequential: {
          type: "boolean",
          description: "Execute invocations in order (not parallel). Use when steps must run in sequence and all arguments are known upfront.",
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
        "1. ALWAYS call search_tools first to find ALL tools you will need for the task. Use queries (array) to search for multiple aspects at once.\n" +
        "2. search_tools returns tool names, descriptions, and input schemas.\n" +
        "3. Use call_tools to invoke discovered tools:\n" +
        "   - Independent operations: batch in one call (parallel by default)\n" +
        "   - Sequential workflows (step1 → step2 → ...): batch with sequential: true\n" +
        "   - Only use separate call_tools calls when you need to inspect an intermediate result before deciding the next step\n\n" +
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
      const query = args.query as string | undefined;
      const queries = args.queries as string[] | undefined;

      if (query && queries) {
        return errorResult("Error: provide either 'query' or 'queries', not both");
      }
      if (!query && !queries) {
        return errorResult("Error: 'query' or 'queries' is required");
      }
      if (queries && queries.length === 0) {
        return errorResult("Error: 'queries' must be a non-empty array");
      }

      const limit = args.limit as number | undefined;
      const isMulti = !!queries;
      const results = isMulti
        ? broker.searchToolsMulti(queries, limit)
        : broker.searchTools(query!, limit);

      if (results.length === 0) {
        const searchDesc = isMulti ? `[${queries.join(", ")}]` : `"${query}"`;
        return textResult(`No tools found matching ${searchDesc}. Try different keywords, or call list_mcp_servers to browse available servers.`);
      }

      // Build response with schemas so the LLM can use call_tools
      const lines = results.map((t, i) => {
        const schema = t.input_schema as Record<string, unknown>;
        const props = schema.properties ? JSON.stringify(schema.properties) : "{}";
        return `${i + 1}. ${t.server_name} / ${t.tool_name} — ${t.description}\n   Input: ${props}`;
      });

      const header = isMulti
        ? `Found ${results.length} tool(s) across ${queries.length} queries:\n\n`
        : `Found ${results.length} tool(s) matching "${query}":\n\n`;

      const effectiveLimit = limit ?? DEFAULT_SEARCH_LIMIT;
      const truncated = !isMulti && results.length >= effectiveLimit;
      const footer = truncated
        ? `\n\nShowing top ${results.length} results (more may exist — refine your query or increase limit). Use call_tools with server_name and tool_name to invoke.`
        : "\n\nUse call_tools with server_name and tool_name to invoke.";

      return textResult(header + lines.join("\n\n") + footer);
    }

    case "add_mcp_server": {
      const serverName = args.name as string;
      const command = args.command as string | undefined;
      const url = args.url as string | undefined;
      if (!serverName) {
        return errorResult("Error: 'name' is required");
      }
      if (!command && !url) {
        return errorResult("Error: either 'command' (stdio) or 'url' (SSE/HTTP) is required");
      }
      if (command && url) {
        return errorResult("Error: provide either 'command' or 'url', not both");
      }
      try {
        const server: ServerRecord = url
          ? { name: serverName, url, headers: args.headers as Record<string, string> | undefined }
          : { name: serverName, command: command!, args: (args.args as string[]) ?? [], env: args.env as Record<string, string> | undefined };
        const { toolCount } = await broker.addServer(server);
        return textResult(`Added server "${serverName}" with ${toolCount} tools.`);
      } catch (err) {
        return errorResult(`Failed to add server "${serverName}": ${getErrorMessage(err)}`);
      }
    }

    case "remove_mcp_server": {
      const serverName = args.name as string;
      if (!serverName) {
        return errorResult("Error: 'name' is required");
      }
      await broker.removeServer(serverName);
      return textResult(`Removed server "${serverName}" and all its tools.`);
    }

    case "list_mcp_servers": {
      const servers = broker.listServers();
      if (servers.length === 0) {
        return textResult("No servers registered. Use add_mcp_server or run `mcp-broker import <config-path>` to add servers.");
      }
      const lines = servers.map(
        (s) => `- **${s.name}**: ${s.toolCount} tools | ${s.connected ? "connected" : "disconnected"}`
      );
      return textResult(lines.join("\n") + "\n\nTo find and call specific tools, use search_tools with a keyword.");
    }

    case "get_mcp_server": {
      const serverName = args.name as string;
      if (!serverName) {
        return errorResult("Error: 'name' is required");
      }
      const server = broker.getServer(serverName);
      if (!server) {
        return errorResult(`Server "${serverName}" not found.`);
      }

      const lines = [`**${server.name}**`];
      if (server.url) {
        lines.push(`- URL: \`${server.url}\``);
        const headerKeys = server.headers ? Object.keys(server.headers) : [];
        lines.push(`- Headers: ${headerKeys.length > 0 ? headerKeys.join(", ") : "(none)"}`);
      } else {
        lines.push(`- Command: \`${server.command}\``);
        lines.push(`- Args: ${server.args && server.args.length > 0 ? server.args.map((a: string) => `\`${a}\``).join(", ") : "(none)"}`);
        const envKeys = server.env ? Object.keys(server.env) : [];
        lines.push(`- Env vars: ${envKeys.length > 0 ? envKeys.join(", ") : "(none)"}`);
      }
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
      return textResult(
        lines.join("\n") +
        "\n\nUse search_tools with a tool name above to get its input schema, then call_tools to invoke it.",
      );
    }

    case "update_mcp_server": {
      const serverName = args.name as string;
      if (!serverName) {
        return errorResult("Error: 'name' is required");
      }

      const updates: ServerUpdate = {};
      let hasUpdates = false;
      if (args.command !== undefined) { updates.command = args.command as string; hasUpdates = true; }
      if (args.args !== undefined) { updates.args = args.args as string[]; hasUpdates = true; }
      if (args.env !== undefined) { updates.env = args.env as Record<string, string>; hasUpdates = true; }
      if (args.url !== undefined) { updates.url = args.url as string; hasUpdates = true; }
      if (args.headers !== undefined) { updates.headers = args.headers as Record<string, string>; hasUpdates = true; }

      if (!hasUpdates) {
        return errorResult("Error: at least one field (command, args, env, url, headers) must be provided");
      }

      if (updates.command !== undefined && updates.url !== undefined) {
        return errorResult("Error: provide either 'command' or 'url', not both");
      }

      try {
        const { toolCount } = await broker.updateServer(serverName, updates);
        const changedFields = Object.keys(updates).join(", ");
        return textResult(`Updated server "${serverName}" (changed: ${changedFields}). ${toolCount} tools indexed.`);
      } catch (err) {
        return errorResult(`Failed to update server "${serverName}": ${getErrorMessage(err)}`);
      }
    }

    case "call_tools": {
      // Accept both {invocations: [...]} and flat {server_name, tool_name, arguments}
      let invocations = args.invocations as ToolInvocation[] | undefined;
      if (!Array.isArray(invocations) && typeof args.server_name === "string" && typeof args.tool_name === "string") {
        invocations = [{ server_name: args.server_name as string, tool_name: args.tool_name as string, arguments: args.arguments as Record<string, unknown> }];
      }
      if (!Array.isArray(invocations) || invocations.length === 0) {
        return errorResult("Error: 'invocations' must be a non-empty array");
      }
      const sequential = args.sequential as boolean | undefined;
      return broker.callTools(invocations, sequential ? { sequential } : undefined);
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
}
