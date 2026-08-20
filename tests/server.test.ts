import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleMetaTool, META_TOOLS, buildDynamicTools, truncateDescription } from "../src/server.js";
import { LIST_TOOLS_DESCRIPTION_MAX_CHARS } from "../src/config.js";
import type { Broker } from "../src/broker.js";

function makeBroker(): Broker {
  return {
    listTools: vi.fn(() => ({ tools: [], unknownServers: [] })),
    describeTools: vi.fn(() => ({ found: [], missing: [] })),
    callTools: vi.fn(),
    addServer: vi.fn(),
    removeServer: vi.fn(),
    listServers: vi.fn(() => []),
    updateServer: vi.fn(),
    refreshTools: vi.fn(),
    startup: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as Broker;
}

describe("META_TOOLS", () => {
  it("defines exactly 7 meta-tools", () => {
    expect(META_TOOLS).toHaveLength(7);
  });

  it("includes all expected tool names", () => {
    const names = META_TOOLS.map((t) => t.name);
    expect(names).toEqual([
      "list_tools",
      "describe_tools",
      "call_tools",
      "add_mcp_server",
      "remove_mcp_server",
      "update_mcp_server",
      "list_mcp_servers",
    ]);
  });

  it("all tools have inputSchema", () => {
    for (const tool of META_TOOLS) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("all tools have annotations", () => {
    for (const tool of META_TOOLS) {
      expect(tool.annotations).toBeDefined();
    }
  });

  it("list_tools, describe_tools, and list_mcp_servers are readOnlyHint", () => {
    const readOnly = META_TOOLS.filter(
      (t) => t.name === "list_tools" || t.name === "describe_tools" || t.name === "list_mcp_servers"
    );
    expect(readOnly).toHaveLength(3);
    for (const tool of readOnly) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("remove_mcp_server is destructiveHint", () => {
    const tool = META_TOOLS.find((t) => t.name === "remove_mcp_server")!;
    expect(tool.annotations?.destructiveHint).toBe(true);
  });

  it("call_tools has openWorldHint", () => {
    const tool = META_TOOLS.find((t) => t.name === "call_tools")!;
    expect(tool.annotations?.openWorldHint).toBe(true);
  });
});

describe("buildDynamicTools", () => {
  it("returns static description when no servers", () => {
    const tools = buildDynamicTools([]);
    const listTools = tools.find((t) => t.name === "list_tools")!;
    expect(listTools.description).toContain("START HERE for any task");
  });

  it("returns dynamic description with server names and tool counts", () => {
    const tools = buildDynamicTools([
      { name: "github", toolCount: 5 },
      { name: "filesystem", toolCount: 3 },
    ]);
    const listTools = tools.find((t) => t.name === "list_tools")!;
    expect(listTools.description).toContain("8 tools");
    expect(listTools.description).toContain("2 server(s)");
    expect(listTools.description).toContain("github, filesystem");
    expect(listTools.description).toContain("START HERE");
  });

  it("caps listed server names at 10", () => {
    const servers = Array.from({ length: 12 }, (_, i) => ({
      name: `server${i}`,
      toolCount: 1,
    }));
    const tools = buildDynamicTools(servers);
    const listTools = tools.find((t) => t.name === "list_tools")!;
    expect(listTools.description).toContain("and 2 more");
    expect(listTools.description).not.toContain("server10");
    expect(listTools.description).not.toContain("server11");
  });

  it("does not modify non-list_tools descriptions", () => {
    const tools = buildDynamicTools([{ name: "github", toolCount: 5 }]);
    const callTools = tools.find((t) => t.name === "call_tools")!;
    expect(callTools.description).toBe(META_TOOLS.find((t) => t.name === "call_tools")!.description);
  });
});

describe("truncateDescription", () => {
  it("returns short first line unchanged", () => {
    expect(truncateDescription("Create a GitHub issue")).toBe("Create a GitHub issue");
  });

  it("keeps only the first line of multi-line descriptions", () => {
    expect(truncateDescription("First line.\nSecond line with much more detail.")).toBe("First line.");
  });

  it("caps long first lines with an ellipsis", () => {
    const long = "x".repeat(300);
    const result = truncateDescription(long);
    expect(result).toHaveLength(LIST_TOOLS_DESCRIPTION_MAX_CHARS);
    expect(result.endsWith("…")).toBe(true);
  });

  it("handles empty and blank-leading descriptions", () => {
    expect(truncateDescription("")).toBe("(no description)");
    expect(truncateDescription("   \n ")).toBe("(no description)");
    expect(truncateDescription("\n\nbody after blank lines")).toBe("body after blank lines");
  });

  it("does not split a surrogate pair at the cap", () => {
    // Emoji (2 UTF-16 code units) straddles the truncation point
    const long = "x".repeat(LIST_TOOLS_DESCRIPTION_MAX_CHARS - 2) + "😀" + "y".repeat(10);
    const result = truncateDescription(long);
    expect(result.endsWith("…")).toBe(true);
    // No lone surrogates anywhere in the output
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result)).toBe(false);
  });
});

describe("handleMetaTool", () => {
  let broker: Broker;

  beforeEach(() => {
    vi.clearAllMocks();
    broker = makeBroker();
  });

  // ── list_tools ──────────────────────────────────────

  describe("list_tools", () => {
    it("groups tools by server with compact lines", async () => {
      vi.mocked(broker.listTools).mockReturnValue({
        tools: [
          { server_name: "github", tool_name: "create_issue", description: "Create a GitHub issue" },
          { server_name: "github", tool_name: "list_repos", description: "List repositories" },
          { server_name: "vibium", tool_name: "browser_navigate", description: "Navigate the browser to a URL" },
        ],
        unknownServers: [],
      });

      const result = await handleMetaTool(broker, "list_tools", {});
      expect(result.isError).toBeUndefined();
      const text = (result.content[0] as any).text;
      expect(text).toContain("3 tools across 2 servers");
      expect(text).toContain("## github (2 tools)");
      expect(text).toContain("## vibium (1 tools)");
      expect(text).toContain("create_issue — Create a GitHub issue");
      expect(text).toContain("browser_navigate — Navigate the browser to a URL");
      expect(text).toContain("describe_tools");
      expect(text).toContain("call_tools");
    });

    it("truncates long descriptions in the listing", async () => {
      vi.mocked(broker.listTools).mockReturnValue({
        tools: [
          { server_name: "srv", tool_name: "big", description: "y".repeat(300) },
          { server_name: "srv", tool_name: "multi", description: "First line.\nSecond line detail." },
        ],
        unknownServers: [],
      });

      const result = await handleMetaTool(broker, "list_tools", {});
      const text = (result.content[0] as any).text;
      expect(text).not.toContain("y".repeat(300));
      expect(text).toContain("…");
      expect(text).toContain("multi — First line.");
      expect(text).not.toContain("Second line detail");
    });

    it("passes server_names filter to broker", async () => {
      vi.mocked(broker.listTools).mockReturnValue({
        tools: [{ server_name: "github", tool_name: "t1", description: "T1" }],
        unknownServers: [],
        matchedServers: ["github"],
      });

      await handleMetaTool(broker, "list_tools", { server_names: ["github"] });
      expect(broker.listTools).toHaveBeenCalledWith(["github"]);
    });

    it("passes empty server_names through (broker treats it as no filter)", async () => {
      vi.mocked(broker.listTools).mockReturnValue({
        tools: [{ server_name: "srv", tool_name: "t1", description: "T1" }],
        unknownServers: [],
      });

      await handleMetaTool(broker, "list_tools", { server_names: [] });
      expect(broker.listTools).toHaveBeenCalledWith([]);
    });

    it("returns error when server_names is not an array of strings", async () => {
      const result = await handleMetaTool(broker, "list_tools", { server_names: "github" });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("'server_names' must be an array of strings");
    });

    it("returns error when all requested servers are unknown", async () => {
      vi.mocked(broker.listTools).mockReturnValue({
        tools: [],
        unknownServers: ["nope", "missing"],
        matchedServers: [],
      });

      const result = await handleMetaTool(broker, "list_tools", { server_names: ["nope", "missing"] });
      expect(result.isError).toBe(true);
      const text = (result.content[0] as any).text;
      expect(text).toContain("Unknown server(s): nope, missing");
      expect(text).toContain("list_mcp_servers");
    });

    it("notes partially unknown servers but still lists the rest", async () => {
      vi.mocked(broker.listTools).mockReturnValue({
        tools: [{ server_name: "github", tool_name: "t1", description: "T1" }],
        unknownServers: ["nope"],
        matchedServers: ["github"],
      });

      const result = await handleMetaTool(broker, "list_tools", { server_names: ["github", "nope"] });
      expect(result.isError).toBeUndefined();
      const text = (result.content[0] as any).text;
      expect(text).toContain("## github");
      expect(text).toContain("unknown server(s) ignored: nope");
    });

    it("handles empty tool index", async () => {
      vi.mocked(broker.listTools).mockReturnValue({ tools: [], unknownServers: [] });

      const result = await handleMetaTool(broker, "list_tools", {});
      expect(result.isError).toBeUndefined();
      const text = (result.content[0] as any).text;
      expect(text).toContain("No tools indexed");
      expect(text).toContain("list_mcp_servers");
    });

    it("names the empty servers when a filter matches no tools", async () => {
      vi.mocked(broker.listTools).mockReturnValue({
        tools: [],
        unknownServers: ["typo"],
        matchedServers: ["newsrv"],
      });

      const result = await handleMetaTool(broker, "list_tools", { server_names: ["newsrv", "typo"] });
      expect(result.isError).toBeUndefined();
      const text = (result.content[0] as any).text;
      expect(text).toContain("No tools indexed for server(s): newsrv");
      expect(text).toContain("Unknown server(s): typo");
      // Must not claim the whole index is empty or suggest re-adding servers
      expect(text).not.toContain("add_mcp_server");
    });
  });

  // ── describe_tools ──────────────────────────────────

  describe("describe_tools", () => {
    it("returns full schemas and untruncated descriptions", async () => {
      const longDescription = "Create a GitHub issue.\n" + "z".repeat(300);
      vi.mocked(broker.describeTools).mockReturnValue({
        found: [
          {
            server_name: "github",
            tool_name: "create_issue",
            description: longDescription,
            input_schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
          },
        ],
        missing: [],
      });

      const result = await handleMetaTool(broker, "describe_tools", {
        tools: [{ server_name: "github", tool_name: "create_issue" }],
      });
      expect(broker.describeTools).toHaveBeenCalledWith([{ server_name: "github", tool_name: "create_issue" }]);
      expect(result.isError).toBeUndefined();
      const text = (result.content[0] as any).text;
      expect(text).toContain("## github / create_issue");
      expect(text).toContain(longDescription);
      expect(text).toContain('"required":["title"]');
      expect(text).toContain("call_tools");
    });

    it("reports missing tools alongside found ones", async () => {
      vi.mocked(broker.describeTools).mockReturnValue({
        found: [
          { server_name: "srv", tool_name: "real", description: "Real tool", input_schema: { type: "object" } },
        ],
        missing: [{ server_name: "srv", tool_name: "fake" }],
      });

      const result = await handleMetaTool(broker, "describe_tools", {
        tools: [
          { server_name: "srv", tool_name: "real" },
          { server_name: "srv", tool_name: "fake" },
        ],
      });
      expect(result.isError).toBeUndefined();
      const text = (result.content[0] as any).text;
      expect(text).toContain("## srv / real");
      expect(text).toContain("Not found: srv / fake");
      expect(text).toContain("list_tools");
    });

    it("returns error when no tools match", async () => {
      vi.mocked(broker.describeTools).mockReturnValue({
        found: [],
        missing: [{ server_name: "srv", tool_name: "fake" }],
      });

      const result = await handleMetaTool(broker, "describe_tools", {
        tools: [{ server_name: "srv", tool_name: "fake" }],
      });
      expect(result.isError).toBe(true);
      const text = (result.content[0] as any).text;
      expect(text).toContain("No matching tools found: srv / fake");
      expect(text).toContain("list_tools");
    });

    it("returns error when tools arg is missing or empty", async () => {
      const missing = await handleMetaTool(broker, "describe_tools", {});
      expect(missing.isError).toBe(true);
      expect((missing.content[0] as any).text).toContain("'tools' must be a non-empty array");

      const empty = await handleMetaTool(broker, "describe_tools", { tools: [] });
      expect(empty.isError).toBe(true);
      expect((empty.content[0] as any).text).toContain("'tools' must be a non-empty array");
    });

    it("returns error when an entry lacks server_name or tool_name", async () => {
      const result = await handleMetaTool(broker, "describe_tools", {
        tools: [{ server_name: "srv" }],
      });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("string 'server_name' and 'tool_name'");
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
      expect((result.content[0] as any).text).toContain("'name' is required");
    });

    it("returns error when neither command nor url is provided", async () => {
      const result = await handleMetaTool(broker, "add_mcp_server", { name: "test" });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("either 'command' (stdio) or 'url' (SSE/HTTP) is required");
    });

    it("returns error when both command and url are provided", async () => {
      const result = await handleMetaTool(broker, "add_mcp_server", { name: "test", command: "npx", url: "https://example.com" });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("either 'command' or 'url', not both");
    });

    it("adds URL-based server successfully", async () => {
      vi.mocked(broker.addServer).mockResolvedValue({ toolCount: 2 });
      const result = await handleMetaTool(broker, "add_mcp_server", {
        name: "remote",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer tok" },
      });
      expect(result.isError).toBeUndefined();
      expect((result.content[0] as any).text).toContain("remote");
      expect((result.content[0] as any).text).toContain("2 tools");
      expect(broker.addServer).toHaveBeenCalledWith(
        expect.objectContaining({ name: "remote", url: "https://example.com/mcp", headers: { Authorization: "Bearer tok" } })
      );
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
    it("formats server list with source and guides toward list_tools", async () => {
      vi.mocked(broker.listServers).mockReturnValue([
        { name: "github", connected: true, toolCount: 2, source: "npx -y @mcp/github", envKeys: [], headerKeys: [] },
        { name: "linear", connected: false, toolCount: 1, source: "https://mcp.linear.app/sse", envKeys: [], headerKeys: [] },
      ]);

      const result = await handleMetaTool(broker, "list_mcp_servers", {});
      const text = (result.content[0] as any).text;
      expect(text).toContain("github");
      expect(text).toContain("2 tools");
      expect(text).toContain("connected");
      expect(text).toContain("disconnected");
      expect(text).toContain("npx -y @mcp/github");
      expect(text).toContain("https://mcp.linear.app/sse");
      // Should NOT contain per-tool details
      expect(text).not.toContain("create_issue");
      // Should guide toward list_tools
      expect(text).toContain("list_tools");
    });

    it("shows env and header key names but never values", async () => {
      vi.mocked(broker.listServers).mockReturnValue([
        { name: "github", connected: true, toolCount: 2, source: "npx -y @mcp/github", envKeys: ["GITHUB_TOKEN", "GITHUB_HOST"], headerKeys: [] },
        { name: "linear", connected: false, toolCount: 1, source: "https://mcp.linear.app/sse", envKeys: [], headerKeys: ["Authorization"] },
      ]);

      const result = await handleMetaTool(broker, "list_mcp_servers", {});
      const text = (result.content[0] as any).text;
      expect(text).toContain("env keys: GITHUB_TOKEN, GITHUB_HOST");
      expect(text).toContain("header keys: Authorization");
    });

    it("handles empty server list", async () => {
      vi.mocked(broker.listServers).mockReturnValue([]);
      const result = await handleMetaTool(broker, "list_mcp_servers", {});
      expect((result.content[0] as any).text).toContain("No servers registered");
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

    it("updates stdio server to URL server", async () => {
      vi.mocked(broker.updateServer).mockResolvedValue({ toolCount: 3 });

      const result = await handleMetaTool(broker, "update_mcp_server", {
        name: "srv",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer tok" },
      });

      expect(broker.updateServer).toHaveBeenCalledWith("srv", {
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer tok" },
      });
      const text = (result.content[0] as any).text;
      expect(text).toContain("Updated");
      expect(text).toContain("url");
      expect(text).toContain("headers");
    });

    it("returns error when both command and url are provided", async () => {
      const result = await handleMetaTool(broker, "update_mcp_server", {
        name: "srv",
        command: "node",
        url: "https://example.com/mcp",
      });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("either 'command' or 'url', not both");
    });

    it("updates URL server headers only", async () => {
      vi.mocked(broker.updateServer).mockResolvedValue({ toolCount: 2 });

      const result = await handleMetaTool(broker, "update_mcp_server", {
        name: "srv",
        headers: { Authorization: "Bearer new-tok" },
      });

      expect(broker.updateServer).toHaveBeenCalledWith("srv", {
        headers: { Authorization: "Bearer new-tok" },
      });
      expect(result.isError).toBeUndefined();
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

      expect(broker.callTools).toHaveBeenCalledWith(
        [{ server_name: "github", tool_name: "create_issue", arguments: { title: "Bug" } }],
        undefined
      );
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

      expect(broker.callTools).toHaveBeenCalledWith(invocations, undefined);
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

      expect(broker.callTools).toHaveBeenCalledWith(
        [{ server_name: "cron", tool_name: "list_tasks", arguments: {} }],
        undefined
      );
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

    it("passes sequential option to broker.callTools", async () => {
      vi.mocked(broker.callTools).mockResolvedValue({
        content: [{ type: "text", text: "result" }],
      });

      await handleMetaTool(broker, "call_tools", {
        invocations: [{ server_name: "srv", tool_name: "t1" }],
        sequential: true,
      });

      expect(broker.callTools).toHaveBeenCalledWith(
        [{ server_name: "srv", tool_name: "t1" }],
        { sequential: true }
      );
    });

    it("does not pass sequential option when not set", async () => {
      vi.mocked(broker.callTools).mockResolvedValue({
        content: [{ type: "text", text: "result" }],
      });

      await handleMetaTool(broker, "call_tools", {
        invocations: [{ server_name: "srv", tool_name: "t1" }],
      });

      expect(broker.callTools).toHaveBeenCalledWith(
        [{ server_name: "srv", tool_name: "t1" }],
        undefined
      );
    });
  });

  // ── unknown tool ────────────────────────────────────

  describe("unknown tool", () => {
    it("throws McpError for unknown tool name", async () => {
      await expect(handleMetaTool(broker, "unknown_tool", {})).rejects.toThrow("Unknown tool");
    });
  });
});
