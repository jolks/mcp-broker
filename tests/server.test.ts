import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleMetaTool, META_TOOLS } from "../src/server.js";
import type { Broker } from "../src/broker.js";

function makeBroker(): Broker {
  return {
    searchTools: vi.fn(() => []),
    callTools: vi.fn(),
    addServer: vi.fn(),
    removeServer: vi.fn(),
    listServers: vi.fn(() => []),
    getServer: vi.fn(),
    updateServer: vi.fn(),
    refreshTools: vi.fn(),
    startup: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as Broker;
}

describe("META_TOOLS", () => {
  it("defines exactly 8 meta-tools", () => {
    expect(META_TOOLS).toHaveLength(8);
  });

  it("includes all expected tool names", () => {
    const names = META_TOOLS.map((t) => t.name);
    expect(names).toEqual([
      "search_tools",
      "add_mcp_server",
      "remove_mcp_server",
      "list_mcp_servers",
      "get_mcp_server",
      "update_mcp_server",
      "refresh_tools",
      "call_tools",
    ]);
  });

  it("all tools have inputSchema", () => {
    for (const tool of META_TOOLS) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }
  });
});

describe("handleMetaTool", () => {
  let broker: Broker;

  beforeEach(() => {
    vi.clearAllMocks();
    broker = makeBroker();
  });

  // ── search_tools ────────────────────────────────────

  describe("search_tools", () => {
    it("returns formatted results with schemas", async () => {
      vi.mocked(broker.searchTools).mockReturnValue([
        {
          id: "github__create_issue",
          server_name: "github",
          tool_name: "create_issue",
          description: "Create a GitHub issue",
          input_schema: { type: "object", properties: { title: { type: "string" } } },
          rank: -1,
        },
      ]);

      const result = await handleMetaTool(broker, "search_tools", { query: "github" });
      expect(result.isError).toBeUndefined();
      const text = (result.content[0] as any).text;
      expect(text).toContain("Found 1 tool(s)");
      expect(text).toContain("github / create_issue");
      expect(text).toContain("Create a GitHub issue");
      expect(text).toContain("Input:");
      expect(text).toContain("call_tools");
    });

    it("returns error when query is missing", async () => {
      const result = await handleMetaTool(broker, "search_tools", {});
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("'query' is required");
    });

    it("handles no results", async () => {
      vi.mocked(broker.searchTools).mockReturnValue([]);
      const result = await handleMetaTool(broker, "search_tools", { query: "nothing" });
      expect((result.content[0] as any).text).toContain("No tools found");
    });

    it("passes limit parameter", async () => {
      vi.mocked(broker.searchTools).mockReturnValue([]);
      await handleMetaTool(broker, "search_tools", { query: "test", limit: 5 });
      expect(broker.searchTools).toHaveBeenCalledWith("test", 5);
    });
  });

  // ── add_mcp_server ──────────────────────────────────

  describe("add_mcp_server", () => {
    it("delegates to broker.addServer", async () => {
      vi.mocked(broker.addServer).mockResolvedValue({ toolCount: 3 });

      const result = await handleMetaTool(broker, "add_mcp_server", {
        name: "github",
        command: "npx",
        args: ["@mcp/github"],
        env: { TOKEN: "abc" },
      });

      expect(broker.addServer).toHaveBeenCalledWith({
        name: "github",
        command: "npx",
        args: ["@mcp/github"],
        env: { TOKEN: "abc" },
      });
      expect((result.content[0] as any).text).toContain("3 tools");
    });

    it("returns error when name is missing", async () => {
      const result = await handleMetaTool(broker, "add_mcp_server", { command: "npx" });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("'name' and 'command' are required");
    });

    it("returns error when command is missing", async () => {
      const result = await handleMetaTool(broker, "add_mcp_server", { name: "test" });
      expect(result.isError).toBe(true);
    });

    it("handles addServer failure", async () => {
      vi.mocked(broker.addServer).mockRejectedValue(new Error("harvest failed"));

      const result = await handleMetaTool(broker, "add_mcp_server", {
        name: "bad",
        command: "npx",
      });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("harvest failed");
    });

    it("defaults args to empty array", async () => {
      vi.mocked(broker.addServer).mockResolvedValue({ toolCount: 0 });
      await handleMetaTool(broker, "add_mcp_server", { name: "s", command: "npx" });
      expect(broker.addServer).toHaveBeenCalledWith(
        expect.objectContaining({ args: [] })
      );
    });
  });

  // ── remove_mcp_server ───────────────────────────────

  describe("remove_mcp_server", () => {
    it("delegates to broker.removeServer", async () => {
      const result = await handleMetaTool(broker, "remove_mcp_server", { name: "github" });
      expect(broker.removeServer).toHaveBeenCalledWith("github");
      expect((result.content[0] as any).text).toContain('Removed server "github"');
    });

    it("returns error when name is missing", async () => {
      const result = await handleMetaTool(broker, "remove_mcp_server", {});
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("'name' is required");
    });
  });

  // ── list_mcp_servers ────────────────────────────────

  describe("list_mcp_servers", () => {
    it("formats server list as summary (no per-tool listing)", async () => {
      vi.mocked(broker.listServers).mockReturnValue([
        { name: "github", connected: true, toolCount: 2 },
        { name: "fs", connected: false, toolCount: 1 },
      ]);

      const result = await handleMetaTool(broker, "list_mcp_servers", {});
      const text = (result.content[0] as any).text;
      expect(text).toContain("github");
      expect(text).toContain("2 tools");
      expect(text).toContain("connected");
      expect(text).toContain("disconnected");
      // Should NOT contain per-tool details
      expect(text).not.toContain("create_issue");
    });

    it("handles empty server list", async () => {
      vi.mocked(broker.listServers).mockReturnValue([]);
      const result = await handleMetaTool(broker, "list_mcp_servers", {});
      expect((result.content[0] as any).text).toContain("No servers registered");
    });
  });

  // ── get_mcp_server ──────────────────────────────────

  describe("get_mcp_server", () => {
    it("returns detailed server info with tool listing", async () => {
      vi.mocked(broker.getServer).mockReturnValue({
        name: "github",
        command: "npx",
        args: ["@mcp/github"],
        env: { GITHUB_TOKEN: "secret" },
        connected: true,
        toolCount: 2,
        tools: [
          { tool_name: "create_issue", description: "Create an issue" },
          { tool_name: "list_repos", description: "List repos" },
        ],
      });

      const result = await handleMetaTool(broker, "get_mcp_server", { name: "github" });
      const text = (result.content[0] as any).text;
      expect(result.isError).toBeUndefined();
      expect(text).toContain("github");
      expect(text).toContain("npx");
      expect(text).toContain("@mcp/github");
      expect(text).toContain("GITHUB_TOKEN");
      // Should NOT contain the actual secret value
      expect(text).not.toContain("secret");
      expect(text).toContain("create_issue");
      expect(text).toContain("list_repos");
      expect(text).toContain("connected");
    });

    it("returns error when name is missing", async () => {
      const result = await handleMetaTool(broker, "get_mcp_server", {});
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("'name' is required");
    });

    it("returns error when server not found", async () => {
      vi.mocked(broker.getServer).mockReturnValue(undefined);
      const result = await handleMetaTool(broker, "get_mcp_server", { name: "missing" });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("not found");
    });

    it("shows only env var keys, not values", async () => {
      vi.mocked(broker.getServer).mockReturnValue({
        name: "srv",
        command: "node",
        args: [],
        env: { API_KEY: "super-secret-123", DB_URL: "postgres://..." },
        connected: false,
        toolCount: 0,
        tools: [],
      });

      const result = await handleMetaTool(broker, "get_mcp_server", { name: "srv" });
      const text = (result.content[0] as any).text;
      expect(text).toContain("API_KEY");
      expect(text).toContain("DB_URL");
      expect(text).not.toContain("super-secret-123");
      expect(text).not.toContain("postgres://");
    });
  });

  // ── update_mcp_server ───────────────────────────────

  describe("update_mcp_server", () => {
    it("delegates to broker.updateServer and returns confirmation", async () => {
      vi.mocked(broker.updateServer).mockResolvedValue({ toolCount: 5 });

      const result = await handleMetaTool(broker, "update_mcp_server", {
        name: "github",
        command: "deno",
      });

      expect(broker.updateServer).toHaveBeenCalledWith("github", { command: "deno" });
      const text = (result.content[0] as any).text;
      expect(text).toContain('Updated server "github"');
      expect(text).toContain("command");
      expect(text).toContain("5 tools");
    });

    it("returns error when name is missing", async () => {
      const result = await handleMetaTool(broker, "update_mcp_server", {});
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("'name' is required");
    });

    it("returns error when no fields provided", async () => {
      const result = await handleMetaTool(broker, "update_mcp_server", { name: "srv" });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("at least one field");
    });

    it("propagates broker errors", async () => {
      vi.mocked(broker.updateServer).mockRejectedValue(new Error('Server "missing" not found'));

      const result = await handleMetaTool(broker, "update_mcp_server", {
        name: "missing",
        command: "x",
      });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("not found");
    });
  });

  // ── refresh_tools ───────────────────────────────────

  describe("refresh_tools", () => {
    it("delegates to broker.refreshTools with server name", async () => {
      const result = await handleMetaTool(broker, "refresh_tools", { server_name: "github" });
      expect(broker.refreshTools).toHaveBeenCalledWith("github");
      expect((result.content[0] as any).text).toContain('"github"');
    });

    it("refreshes all when no server name", async () => {
      const result = await handleMetaTool(broker, "refresh_tools", {});
      expect(broker.refreshTools).toHaveBeenCalledWith(undefined);
      expect((result.content[0] as any).text).toContain("all servers");
    });
  });

  // ── call_tools ─────────────────────────────────────

  describe("call_tools", () => {
    it("delegates to broker.callTools with invocations array", async () => {
      vi.mocked(broker.callTools).mockResolvedValue({
        content: [{ type: "text", text: "result" }],
      });

      const result = await handleMetaTool(broker, "call_tools", {
        invocations: [
          { server_name: "github", tool_name: "create_issue", arguments: { title: "Bug" } },
        ],
      });

      expect(broker.callTools).toHaveBeenCalledWith([
        { server_name: "github", tool_name: "create_issue", arguments: { title: "Bug" } },
      ]);
      expect((result.content[0] as any).text).toBe("result");
    });

    it("handles multiple invocations", async () => {
      vi.mocked(broker.callTools).mockResolvedValue({
        content: [{ type: "text", text: "multi-result" }],
      });

      const invocations = [
        { server_name: "echo", tool_name: "ping" },
        { server_name: "github", tool_name: "list_issues", arguments: { repo: "test" } },
      ];
      const result = await handleMetaTool(broker, "call_tools", { invocations });

      expect(broker.callTools).toHaveBeenCalledWith(invocations);
      expect((result.content[0] as any).text).toBe("multi-result");
    });

    it("accepts flat {server_name, tool_name, arguments} without invocations wrapper", async () => {
      vi.mocked(broker.callTools).mockResolvedValue({
        content: [{ type: "text", text: "flat-result" }],
      });

      const result = await handleMetaTool(broker, "call_tools", {
        server_name: "cron",
        tool_name: "list_tasks",
        arguments: {},
      });

      expect(broker.callTools).toHaveBeenCalledWith([
        { server_name: "cron", tool_name: "list_tasks", arguments: {} },
      ]);
      expect((result.content[0] as any).text).toBe("flat-result");
    });

    it("returns error when invocations is missing", async () => {
      const result = await handleMetaTool(broker, "call_tools", {});
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("'invocations' must be a non-empty array");
    });

    it("returns error when invocations is empty array", async () => {
      const result = await handleMetaTool(broker, "call_tools", { invocations: [] });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("'invocations' must be a non-empty array");
    });
  });

  // ── unknown tool ────────────────────────────────────

  describe("unknown tool", () => {
    it("throws McpError for unknown tool name", async () => {
      await expect(handleMetaTool(broker, "unknown_tool", {})).rejects.toThrow("Unknown tool");
    });
  });
});
