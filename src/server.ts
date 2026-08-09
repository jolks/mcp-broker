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
import type { ServerRecord, ToolRef } from "./store.js";
import { logger } from "./logger.js";
import { VERSION, SERVER_NAME, LIST_TOOLS_DESCRIPTION_MAX_CHARS, getErrorMessage } from "./config.js";

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
    name: "list_tools",
    description:
      "START HERE for any task. Lists every tool available through this gateway, grouped by server, " +
      "one line per tool (name — short description) — like browsing a CLI's command list. " +
      "Pass server_names to only list tools from specific servers. " +
      "Next step: describe_tools to get input schemas for the tools you pick, then call_tools to run them.",
    inputSchema: {
      type: "object" as const,
      properties: {
        server_names: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: restrict listing to these servers (names as shown by list_mcp_servers). " +
            "Omit to list all tools from all servers.",
        },
      },
      required: [],
    },
    annotations: { title: "List Available Tools", readOnlyHint: true },
  },
  {
    name: "describe_tools",
    description:
      "Get the full input schemas for specific tools found via list_tools — like reading --help " +
      "before running a command. ALWAYS describe a tool before calling it for the first time; " +
      "never guess arguments. Batch every tool you plan to use into one call.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tools: {
          type: "array",
          items: {
            type: "object",
            properties: {
              server_name: { type: "string", description: "Server name from list_tools" },
              tool_name: { type: "string", description: "Tool name from list_tools" },
            },
            required: ["server_name", "tool_name"],
          },
          description: "Tools to describe (from list_tools output)",
        },
      },
      required: ["tools"],
    },
    annotations: { title: "Describe Tools", readOnlyHint: true },
  },
  {
    name: "call_tools",
    description:
      "Call tools discovered via list_tools. " +
      "You SHOULD call describe_tools first — argument schemas come from there. " +
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
              server_name: { type: "string", description: "Server name from list_tools" },
              tool_name: { type: "string", description: "Tool name from list_tools" },
              arguments: { type: "object", description: "Arguments for the tool (see input schema from describe_tools)" },
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
  {
    name: "add_mcp_server",
    description:
      "Register a new MCP server (stdio or URL-based). The server will be connected, its tools harvested and added to the tool listing. " +
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
    name: "list_mcp_servers",
    description:
      "List all registered MCP servers with connection status, tool count, and how each is launched (command or URL). " +
      "Use list_tools to browse the tools they provide.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    annotations: { title: "List Servers", readOnlyHint: true },
  },
];

const META_TOOL_NAMES = new Set(META_TOOLS.map((t) => t.name));

// ── Description truncation for list_tools ────────────────

/** First non-empty line of a tool description, hard-capped for compact listings. */
export function truncateDescription(desc: string): string {
  const firstLine = desc.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  if (!firstLine) return "(no description)";
  if (firstLine.length <= LIST_TOOLS_DESCRIPTION_MAX_CHARS) return firstLine;
  return firstLine.slice(0, LIST_TOOLS_DESCRIPTION_MAX_CHARS - 1).trimEnd() + "…";
}

// ── Dynamic description builder ──────────────────────────

export function buildDynamicTools(
  servers: Array<{ name: string; toolCount: number }>
): Tool[] {
  const totalTools = servers.reduce((sum, s) => sum + s.toolCount, 0);

  return META_TOOLS.map((t) => {
    if (t.name !== "list_tools" || servers.length === 0) return t;

    const MAX_LISTED = 10;
    const names = servers.map((s) => s.name);
    const serverNames =
      names.length <= MAX_LISTED
        ? names.join(", ")
        : names.slice(0, MAX_LISTED).join(", ") + `, and ${names.length - MAX_LISTED} more`;

    return {
      ...t,
      description:
        `START HERE for any task. This gateway provides ${totalTools} tools ` +
        `across ${servers.length} server(s) (${serverNames}). ` +
        "Lists every tool, one line each, grouped by server. Optionally filter with server_names. " +
        "Then use describe_tools to get input schemas, and call_tools to invoke.",
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
        "You do NOT have direct access to those tools — discover them the way you would CLI commands: " +
        "browse the list, read the help, then run.\n\n" +
        "WORKFLOW:\n" +
        "1. list_tools — browse all available tools (one compact line each, grouped by server). " +
        "Filter with server_names when you already know which server you need.\n" +
        "2. describe_tools — get full input schemas for ALL tools you plan to use, batched in ONE call. " +
        "Never call a tool whose schema you have not seen.\n" +
        "3. call_tools — invoke tools:\n" +
        "   - Independent operations: batch in one call (parallel by default)\n" +
        "   - Sequential workflows (step1 → step2 → ...) with all arguments known upfront: batch with sequential: true\n" +
        "   - Only use separate call_tools calls when you must inspect an intermediate result first\n\n" +
        "list_mcp_servers shows registered servers (status, tool count, command/URL) and is mainly for " +
        "managing servers with add/update/remove_mcp_server.\n\n" +
        "IMPORTANT: Do not guess tool names or arguments — list first, describe before calling.",
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
    case "list_tools": {
      const serverNames = args.server_names as string[] | undefined;
      if (serverNames !== undefined) {
        if (!Array.isArray(serverNames) || serverNames.some((n) => typeof n !== "string")) {
          return errorResult("Error: 'server_names' must be an array of strings");
        }
      }

      // Empty array is treated as "no filter" — most forgiving for LLM callers
      const filter = serverNames && serverNames.length > 0 ? serverNames : undefined;
      const { tools, unknownServers } = broker.listTools(filter);

      if (filter && unknownServers.length === filter.length) {
        return errorResult(
          `Unknown server(s): ${unknownServers.join(", ")}. Call list_mcp_servers to see registered servers.`
        );
      }
      if (tools.length === 0) {
        return textResult(
          "No tools indexed. Use list_mcp_servers to check registered servers, or add_mcp_server to add one."
        );
      }

      // Group by server, one compact line per tool
      const byServer = new Map<string, typeof tools>();
      for (const t of tools) {
        const group = byServer.get(t.server_name);
        if (group) group.push(t);
        else byServer.set(t.server_name, [t]);
      }

      const sections: string[] = [];
      for (const [serverName, serverTools] of byServer) {
        const lines = serverTools.map((t) => `${t.tool_name} — ${truncateDescription(t.description)}`);
        sections.push(`## ${serverName} (${serverTools.length} tools)\n${lines.join("\n")}`);
      }

      const header = `${tools.length} tools across ${byServer.size} servers:\n\n`;
      const unknownNote = unknownServers.length > 0
        ? `\n\n(Note: unknown server(s) ignored: ${unknownServers.join(", ")})`
        : "";
      const footer =
        "\n\nNext: call describe_tools with every tool you plan to use (batch them in one call) " +
        "to get input schemas, then call_tools to invoke.";

      return textResult(header + sections.join("\n\n") + unknownNote + footer);
    }

    case "describe_tools": {
      const refs = args.tools as ToolRef[] | undefined;
      if (!Array.isArray(refs) || refs.length === 0) {
        return errorResult("Error: 'tools' must be a non-empty array of { server_name, tool_name }");
      }
      if (refs.some((r) => typeof r?.server_name !== "string" || typeof r?.tool_name !== "string")) {
        return errorResult("Error: each entry in 'tools' must have string 'server_name' and 'tool_name'");
      }

      const { found, missing } = broker.describeTools(refs);
      if (found.length === 0) {
        return errorResult(
          `No matching tools found: ${refs.map((r) => `${r.server_name} / ${r.tool_name}`).join(", ")}. ` +
          "Check exact names via list_tools."
        );
      }

      const sections = found.map((t) => {
        const desc = t.description ? `${t.description}\n` : "";
        return `## ${t.server_name} / ${t.tool_name}\n${desc}Input schema: ${JSON.stringify(t.input_schema)}`;
      });

      const missingNote = missing.length > 0
        ? `\n\nNot found: ${missing.map((r) => `${r.server_name} / ${r.tool_name}`).join(", ")} (check names via list_tools)`
        : "";
      const footer =
        "\n\nUse call_tools with server_name, tool_name, and arguments matching the schema. " +
        "Batch independent calls; use sequential: true for ordered steps.";

      return textResult(sections.join("\n\n") + missingNote + footer);
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
        return textResult(
          `Added server "${serverName}" with ${toolCount} tools. ` +
          `Use list_tools with server_names: ["${serverName}"] to browse them.`
        );
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
        (s) => `- **${s.name}**: ${s.toolCount} tools | ${s.connected ? "connected" : "disconnected"} | ${s.source}`
      );
      return textResult(
        lines.join("\n") +
        "\n\nUse list_tools (optionally with server_names) to browse tools, then describe_tools → call_tools."
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
