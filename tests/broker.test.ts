import { describe, it, expect, vi, beforeEach } from "vitest";
import { Broker } from "../src/broker.js";
import type { Store, ToolListing, ToolDetail } from "../src/store.js";
import type { Pool } from "../src/pool.js";
import type { Registry } from "../src/registry.js";
import { makeServer, makeUrlServer, makeStore, makePool, makeRegistry } from "./helpers.js";

// Mock harvester
vi.mock("../src/harvester.js", () => ({
  harvestTools: vi.fn(),
}));

import { harvestTools } from "../src/harvester.js";
const mockHarvestTools = vi.mocked(harvestTools);

describe("Broker", () => {
  let store: Store;
  let pool: Pool;
  let registry: Registry;
  let broker: Broker;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeStore();
    pool = makePool();
    registry = makeRegistry();
    broker = new Broker(store, pool, registry);
  });

  // ── listTools ───────────────────────────────────────

  describe("listTools", () => {
    it("delegates to store.listAllTools", () => {
      const mockTools: ToolListing[] = [
        { server_name: "srv", tool_name: "tool", description: "A tool" },
      ];
      vi.mocked(store.listAllTools).mockReturnValue(mockTools);
      vi.mocked(store.listServers).mockReturnValue([makeServer({ name: "srv" })]);

      const result = broker.listTools();
      expect(store.listAllTools).toHaveBeenCalledWith(undefined);
      expect(result).toEqual({ tools: mockTools, unknownServers: [] });
    });

    it("passes server filter through and flags unknown servers", () => {
      vi.mocked(store.listAllTools).mockReturnValue([
        { server_name: "github", tool_name: "t1", description: "T1" },
      ]);
      vi.mocked(store.listServers).mockReturnValue([makeServer({ name: "github" })]);

      const result = broker.listTools(["github", "nope"]);
      expect(store.listAllTools).toHaveBeenCalledWith(["github", "nope"]);
      expect(result.unknownServers).toEqual(["nope"]);
      expect(result.tools).toHaveLength(1);
    });
  });

  // ── describeTools ───────────────────────────────────

  describe("describeTools", () => {
    it("splits found and missing refs", () => {
      const found: ToolDetail[] = [
        { server_name: "srv", tool_name: "real", description: "Real", input_schema: { type: "object" } },
      ];
      vi.mocked(store.getToolDetails).mockReturnValue(found);

      const result = broker.describeTools([
        { server_name: "srv", tool_name: "real" },
        { server_name: "srv", tool_name: "fake" },
      ]);
      expect(store.getToolDetails).toHaveBeenCalledWith([
        { server_name: "srv", tool_name: "real" },
        { server_name: "srv", tool_name: "fake" },
      ]);
      expect(result.found).toEqual(found);
      expect(result.missing).toEqual([{ server_name: "srv", tool_name: "fake" }]);
    });

    it("returns empty missing when all found", () => {
      vi.mocked(store.getToolDetails).mockReturnValue([
        { server_name: "srv", tool_name: "t1", description: "", input_schema: {} },
      ]);

      const result = broker.describeTools([{ server_name: "srv", tool_name: "t1" }]);
      expect(result.missing).toEqual([]);
    });
  });

  // ── callTools ───────────────────────────────────────

  describe("callTools", () => {
    it("passes through single invocation result directly", async () => {
      const mockClient = {
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "result" }],
        }),
      };
      vi.mocked(pool.getClient).mockReturnValue(mockClient as any);

      const result = await broker.callTools([
        { server_name: "srv", tool_name: "tool", arguments: { arg: "value" } },
      ]);
      expect(pool.getClient).toHaveBeenCalledWith("srv");
      expect(mockClient.callTool).toHaveBeenCalledWith({
        name: "tool",
        arguments: { arg: "value" },
      });
      // Single invocation: result passed through as-is
      expect(result.content).toEqual([{ type: "text", text: "result" }]);
      expect(result.isError).toBeUndefined();
    });

    it("returns error when server not connected", async () => {
      vi.mocked(pool.getClient).mockReturnValue(undefined);

      const result = await broker.callTools([
        { server_name: "srv", tool_name: "tool" },
      ]);
      // Single invocation: error passed through directly
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("not connected");
    });

    it("returns error when underlying callTool throws", async () => {
      const mockClient = {
        callTool: vi.fn().mockRejectedValue(new Error("timeout")),
      };
      vi.mocked(pool.getClient).mockReturnValue(mockClient as any);

      const result = await broker.callTools([
        { server_name: "srv", tool_name: "tool" },
      ]);
      // Single invocation: error passed through directly
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("timeout");
    });

    it("flattens multiple invocations with headers", async () => {
      const mockClient = {
        callTool: vi.fn()
          .mockResolvedValueOnce({ content: [{ type: "text", text: "r1" }] })
          .mockResolvedValueOnce({ content: [{ type: "text", text: "r2" }] }),
      };
      vi.mocked(pool.getClient).mockReturnValue(mockClient as any);

      const result = await broker.callTools([
        { server_name: "srv", tool_name: "t1", arguments: {} },
        { server_name: "srv", tool_name: "t2", arguments: {} },
      ]);
      // Multiple invocations: flattened with headers
      expect(result.content).toEqual([
        { type: "text", text: "[srv/t1]" },
        { type: "text", text: "r1" },
        { type: "text", text: "[srv/t2]" },
        { type: "text", text: "r2" },
      ]);
      expect(result.isError).toBeUndefined();
    });

    it("executes sequentially when sequential option is set", async () => {
      const callOrder: string[] = [];
      const mockClient = {
        callTool: vi.fn().mockImplementation(({ name }: { name: string }) => {
          callOrder.push(name);
          return Promise.resolve({ content: [{ type: "text", text: `${name}-result` }] });
        }),
      };
      vi.mocked(pool.getClient).mockReturnValue(mockClient as any);

      const result = await broker.callTools(
        [
          { server_name: "srv", tool_name: "step1", arguments: {} },
          { server_name: "srv", tool_name: "step2", arguments: {} },
          { server_name: "srv", tool_name: "step3", arguments: {} },
        ],
        { sequential: true }
      );

      // Verify order
      expect(callOrder).toEqual(["step1", "step2", "step3"]);
      // Always uses multi-result format with headers
      expect(result.content).toEqual([
        { type: "text", text: "[srv/step1]" },
        { type: "text", text: "step1-result" },
        { type: "text", text: "[srv/step2]" },
        { type: "text", text: "step2-result" },
        { type: "text", text: "[srv/step3]" },
        { type: "text", text: "step3-result" },
      ]);
      expect(result.isError).toBeUndefined();
    });

    it("sequential mode stops on first error", async () => {
      const mockClient = {
        callTool: vi.fn()
          .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] })
          .mockResolvedValueOnce({ content: [{ type: "text", text: "fail" }], isError: true })
          .mockResolvedValueOnce({ content: [{ type: "text", text: "never" }] }),
      };
      vi.mocked(pool.getClient).mockReturnValue(mockClient as any);

      const result = await broker.callTools(
        [
          { server_name: "srv", tool_name: "t1" },
          { server_name: "srv", tool_name: "t2" },
          { server_name: "srv", tool_name: "t3" },
        ],
        { sequential: true }
      );

      // Should have called t1 and t2 but not t3
      expect(mockClient.callTool).toHaveBeenCalledTimes(2);
      expect(result.content).toEqual([
        { type: "text", text: "[srv/t1]" },
        { type: "text", text: "ok" },
        { type: "text", text: "[srv/t2]" },
        { type: "text", text: "fail" },
      ]);
      expect(result.isError).toBe(true);
    });

    it("sequential mode uses headers even for single invocation", async () => {
      const mockClient = {
        callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "result" }] }),
      };
      vi.mocked(pool.getClient).mockReturnValue(mockClient as any);

      const result = await broker.callTools(
        [{ server_name: "srv", tool_name: "tool", arguments: {} }],
        { sequential: true }
      );

      // Sequential always uses header format (unlike parallel which passes through for single)
      expect(result.content).toEqual([
        { type: "text", text: "[srv/tool]" },
        { type: "text", text: "result" },
      ]);
    });

    it("handles partial failure (one succeeds, one fails)", async () => {
      const mockClientOk = {
        callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
      };
      const mockClientBad = undefined;
      vi.mocked(pool.getClient).mockImplementation((name: string) =>
        name === "good" ? (mockClientOk as any) : mockClientBad
      );

      const result = await broker.callTools([
        { server_name: "good", tool_name: "t1" },
        { server_name: "bad", tool_name: "t2" },
      ]);
      // Multiple invocations: flattened with headers, isError set
      expect(result.content).toEqual([
        { type: "text", text: "[good/t1]" },
        { type: "text", text: "ok" },
        { type: "text", text: "[bad/t2]" },
        { type: "text", text: expect.stringContaining("not connected") },
      ]);
      expect(result.isError).toBe(true);
    });
  });

  // ── addServer ───────────────────────────────────────

  describe("addServer", () => {
    it("writes to registry, upserts store, harvests tools, and connects pool", async () => {
      const server = makeServer();
      mockHarvestTools.mockResolvedValue([
        { tool_name: "t1", description: "Tool 1", input_schema: "{}" },
        { tool_name: "t2", description: "Tool 2", input_schema: "{}" },
      ]);

      const result = await broker.addServer(server);

      expect(registry.addServer).toHaveBeenCalledWith("test-server", {
        command: server.command,
        args: server.args,
        env: server.env,
      });
      expect(store.upsertServer).toHaveBeenCalledWith(server);
      expect(mockHarvestTools).toHaveBeenCalledWith(server);
      expect(store.upsertTools).toHaveBeenCalledWith("test-server", [
        { tool_name: "t1", description: "Tool 1", input_schema: "{}" },
        { tool_name: "t2", description: "Tool 2", input_schema: "{}" },
      ]);
      expect(pool.connectServer).toHaveBeenCalledWith(server);
      expect(result.toolCount).toBe(2);
    });

    it("does not throw if pool.connectServer fails", async () => {
      const server = makeServer();
      mockHarvestTools.mockResolvedValue([]);
      vi.mocked(pool.connectServer).mockRejectedValue(new Error("connect failed"));

      // Should not throw
      await broker.addServer(server);
    });
  });

  // ── removeServer ────────────────────────────────────

  describe("removeServer", () => {
    it("removes from registry, disconnects pool, and removes from store", async () => {
      await broker.removeServer("srv");

      expect(registry.removeServer).toHaveBeenCalledWith("srv");
      expect(pool.disconnectServer).toHaveBeenCalledWith("srv");
      expect(store.removeServer).toHaveBeenCalledWith("srv");
    });
  });

  // ── listServers ─────────────────────────────────────

  describe("listServers", () => {
    it("enriches with connected status, tool count, and source", () => {
      vi.mocked(store.listServers).mockReturnValue([
        makeServer({ name: "a", command: "npx", args: ["-y", "@mcp/a"] }),
        makeUrlServer({ name: "b", url: "https://mcp.example.com/sse" }),
      ]);
      vi.mocked(pool.isConnected).mockImplementation((name: string) => name === "a");
      vi.mocked(store.getToolCount).mockImplementation((name: string) =>
        name === "a" ? 2 : 0
      );

      const result = broker.listServers();
      expect(result).toEqual([
        { name: "a", connected: true, toolCount: 2, source: "npx -y @mcp/a" },
        { name: "b", connected: false, toolCount: 0, source: "https://mcp.example.com/sse" },
      ]);
    });

    it("never exposes env values in source", () => {
      vi.mocked(store.listServers).mockReturnValue([
        makeServer({ name: "a", command: "node", args: ["srv.js"], env: { TOKEN: "sekret" } }),
      ]);

      const result = broker.listServers();
      expect(JSON.stringify(result)).not.toContain("sekret");
    });

    it("returns empty array when no servers", () => {
      vi.mocked(store.listServers).mockReturnValue([]);
      expect(broker.listServers()).toEqual([]);
    });
  });

  // ── updateServer ─────────────────────────────────────

  describe("updateServer", () => {
    it("updates registry, store, re-harvests, and reconnects", async () => {
      vi.mocked(store.getServer).mockReturnValue(
        makeServer({ name: "srv", command: "node", args: ["old.js"] })
      );
      mockHarvestTools.mockResolvedValue([
        { tool_name: "t1", description: "T1", input_schema: "{}" },
      ]);

      const result = await broker.updateServer("srv", { command: "deno" });

      expect(registry.addServer).toHaveBeenCalledWith("srv", expect.objectContaining({ command: "deno" }));
      expect(store.upsertServer).toHaveBeenCalledWith(expect.objectContaining({ name: "srv", command: "deno" }));
      expect(pool.disconnectServer).toHaveBeenCalledWith("srv");
      expect(mockHarvestTools).toHaveBeenCalledWith(expect.objectContaining({ name: "srv", command: "deno", args: ["old.js"] }));
      expect(store.upsertTools).toHaveBeenCalled();
      expect(pool.connectServer).toHaveBeenCalled();
      expect(result.toolCount).toBe(1);
    });

    it("merges partial updates with existing config", async () => {
      vi.mocked(store.getServer).mockReturnValue(
        makeServer({ name: "srv", command: "node", args: ["old.js"], env: { KEY: "val" } })
      );
      mockHarvestTools.mockResolvedValue([]);

      await broker.updateServer("srv", { args: ["new.js"] });

      expect(store.upsertServer).toHaveBeenCalledWith(
        expect.objectContaining({ command: "node", args: ["new.js"], env: { KEY: "val" } })
      );
    });

    it("throws when server not found", async () => {
      vi.mocked(store.getServer).mockReturnValue(undefined);

      await expect(broker.updateServer("missing", { command: "x" }))
        .rejects.toThrow('Server "missing" not found');
    });

    it("switches from stdio to URL", async () => {
      vi.mocked(store.getServer).mockReturnValue(
        makeServer({ name: "srv", command: "node", args: ["old.js"] })
      );
      mockHarvestTools.mockResolvedValue([]);

      await broker.updateServer("srv", { url: "https://example.com/mcp", headers: { Auth: "tok" } });

      expect(store.upsertServer).toHaveBeenCalledWith(
        expect.objectContaining({ name: "srv", url: "https://example.com/mcp", headers: { Auth: "tok" } })
      );
      // Should NOT contain command
      const upsertArg = vi.mocked(store.upsertServer).mock.calls[0][0];
      expect("command" in upsertArg).toBe(false);
    });

    it("switches from URL to stdio", async () => {
      vi.mocked(store.getServer).mockReturnValue(
        makeUrlServer({ name: "srv", url: "https://old.example.com/mcp" })
      );
      mockHarvestTools.mockResolvedValue([]);

      await broker.updateServer("srv", { command: "deno", args: ["new.ts"] });

      expect(store.upsertServer).toHaveBeenCalledWith(
        expect.objectContaining({ name: "srv", command: "deno", args: ["new.ts"] })
      );
      const upsertArg = vi.mocked(store.upsertServer).mock.calls[0][0];
      expect("url" in upsertArg).toBe(false);
    });

    it("updates URL headers only", async () => {
      vi.mocked(store.getServer).mockReturnValue(
        makeUrlServer({ name: "srv", url: "https://example.com/mcp", headers: { Old: "header" } })
      );
      mockHarvestTools.mockResolvedValue([]);

      await broker.updateServer("srv", { headers: { New: "header" } });

      expect(store.upsertServer).toHaveBeenCalledWith(
        expect.objectContaining({ name: "srv", url: "https://example.com/mcp", headers: { New: "header" } })
      );
    });

    it("type switch lifecycle: disconnect, re-harvest, reconnect", async () => {
      vi.mocked(store.getServer).mockReturnValue(
        makeServer({ name: "srv", command: "node", args: [] })
      );
      mockHarvestTools.mockResolvedValue([
        { tool_name: "t1", description: "T1", input_schema: "{}" },
      ]);

      await broker.updateServer("srv", { url: "https://example.com/mcp" });

      expect(pool.disconnectServer).toHaveBeenCalledWith("srv");
      expect(mockHarvestTools).toHaveBeenCalledWith(
        expect.objectContaining({ name: "srv", url: "https://example.com/mcp" })
      );
      expect(store.upsertTools).toHaveBeenCalledWith("srv", [
        { tool_name: "t1", description: "T1", input_schema: "{}" },
      ]);
      expect(pool.connectServer).toHaveBeenCalled();
    });
  });

  // ── refreshTools ────────────────────────────────────

  describe("refreshTools", () => {
    it("refreshes tools for a specific server from registry", async () => {
      vi.mocked(registry.listEntries).mockReturnValue([
        { name: "srv", entry: { command: "node", args: ["server.js"], env: undefined } },
        { name: "other", entry: { command: "node", args: ["other.js"] } },
      ]);
      mockHarvestTools.mockResolvedValue([
        { tool_name: "t1", description: "T1", input_schema: "{}" },
      ]);

      await broker.refreshTools("srv");

      expect(registry.listEntries).toHaveBeenCalled();
      expect(mockHarvestTools).toHaveBeenCalledTimes(1);
      expect(mockHarvestTools).toHaveBeenCalledWith(expect.objectContaining({ name: "srv", command: "node", args: ["server.js"] }));
      expect(store.upsertTools).toHaveBeenCalled();
    });

    it("refreshes all servers from registry when no name given", async () => {
      vi.mocked(registry.listEntries).mockReturnValue([
        { name: "a", entry: { command: "cmd-a", args: [] } },
        { name: "b", entry: { command: "cmd-b", args: [] } },
      ]);
      mockHarvestTools.mockResolvedValue([]);

      await broker.refreshTools();

      expect(mockHarvestTools).toHaveBeenCalledTimes(2);
    });

    it("does not throw if harvestTools fails for one server", async () => {
      vi.mocked(registry.listEntries).mockReturnValue([
        { name: "a", entry: { command: "cmd-a", args: [] } },
        { name: "b", entry: { command: "cmd-b", args: [] } },
      ]);
      mockHarvestTools
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValueOnce([]);

      // Should not throw
      await broker.refreshTools();
      expect(mockHarvestTools).toHaveBeenCalledTimes(2);
    });
  });

  // ── lifecycle ───────────────────────────────────────

  describe("lifecycle", () => {
    it("startup syncs from registry and connects servers", async () => {
      vi.mocked(registry.listEntries).mockReturnValue([
        { name: "a", entry: { command: "cmd-a", args: ["arg1"] } },
      ]);
      vi.mocked(store.listServers).mockReturnValue([]);
      // After upsertServer, listServers returns the new server
      vi.mocked(store.listServers).mockReturnValueOnce([]).mockReturnValue([
        makeServer({ name: "a", command: "cmd-a", args: ["arg1"] }),
      ]);

      await broker.startup();

      // Should upsert from registry
      expect(store.upsertServer).toHaveBeenCalledWith(
        expect.objectContaining({ name: "a", command: "cmd-a" })
      );
      expect(pool.connectAll).toHaveBeenCalled();
    });

    it("startup migrates from SQLite to registry when registry is empty", async () => {
      vi.mocked(registry.listEntries)
        .mockReturnValueOnce([]) // first call: empty
        .mockReturnValue([{ name: "legacy", entry: { command: "cmd-legacy", args: [] } }]);
      vi.mocked(store.listServers).mockReturnValue([
        makeServer({ name: "legacy", command: "cmd-legacy", args: [] }),
      ]);

      await broker.startup();

      expect(registry.importServers).toHaveBeenCalledWith({
        legacy: { command: "cmd-legacy", args: [], env: undefined },
      });
    });

    it("startup removes stale SQLite entries not in registry", async () => {
      vi.mocked(registry.listEntries).mockReturnValue([
        { name: "keep", entry: { command: "cmd-keep", args: [] } },
      ]);
      vi.mocked(store.listServers)
        .mockReturnValueOnce([
          makeServer({ name: "keep", command: "cmd-keep" }),
          makeServer({ name: "stale", command: "cmd-stale" }),
        ])
        .mockReturnValue([makeServer({ name: "keep", command: "cmd-keep" })]);

      await broker.startup();

      expect(store.removeServer).toHaveBeenCalledWith("stale");
      expect(store.removeServer).not.toHaveBeenCalledWith("keep");
    });

    it("startup skips harvesting when tools already indexed", async () => {
      const recentTimestamp = new Date().toISOString().replace("Z", "").replace("T", " ");
      vi.mocked(registry.listEntries).mockReturnValue([
        { name: "a", entry: { command: "cmd-a", args: [] } },
      ]);
      vi.mocked(store.listServers).mockReturnValue([]);
      vi.mocked(store.getToolCount).mockReturnValue(5); // already has tools
      vi.mocked(store.getLastHarvestedAt).mockReturnValue(recentTimestamp);

      await broker.startup();
      await broker.shutdown();

      expect(mockHarvestTools).not.toHaveBeenCalled();
    });

    it("startup harvests tools when not yet indexed", async () => {
      vi.mocked(registry.listEntries).mockReturnValue([
        { name: "a", entry: { command: "cmd-a", args: [] } },
      ]);
      vi.mocked(store.listServers).mockReturnValue([]);
      vi.mocked(store.getToolCount).mockReturnValue(0);
      mockHarvestTools.mockResolvedValue([
        { tool_name: "t1", description: "T1", input_schema: "{}" },
      ]);

      await broker.startup();

      expect(mockHarvestTools).toHaveBeenCalledWith(expect.objectContaining({ name: "a", command: "cmd-a", args: [] }));
      expect(store.upsertTools).toHaveBeenCalled();
    });

    it("shutdown closes pool and store", async () => {
      await broker.shutdown();
      expect(pool.closeAll).toHaveBeenCalled();
      expect(store.close).toHaveBeenCalled();
    });

    it("startup triggers background refresh for stale servers", async () => {
      const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace("Z", "").replace("T", " ");
      vi.mocked(registry.listEntries).mockReturnValue([
        { name: "stale-srv", entry: { command: "cmd", args: [] } },
      ]);
      vi.mocked(store.listServers)
        .mockReturnValueOnce([])
        .mockReturnValue([makeServer({ name: "stale-srv", command: "cmd", args: [] })]);
      vi.mocked(store.getToolCount).mockReturnValue(3); // already indexed
      vi.mocked(store.getLastHarvestedAt).mockReturnValue(oldTimestamp);
      mockHarvestTools.mockResolvedValue([
        { tool_name: "t1", description: "T1", input_schema: "{}" },
      ]);

      await broker.startup();
      await broker.shutdown();

      // harvestTools called once during background refresh (not during initial startup since toolCount > 0)
      expect(mockHarvestTools).toHaveBeenCalledWith(expect.objectContaining({ name: "stale-srv", command: "cmd", args: [] }));
    });

    it("startup skips background refresh for recently harvested servers", async () => {
      const recentTimestamp = new Date().toISOString().replace("Z", "").replace("T", " ");
      vi.mocked(registry.listEntries).mockReturnValue([
        { name: "fresh-srv", entry: { command: "cmd", args: [] } },
      ]);
      vi.mocked(store.listServers)
        .mockReturnValueOnce([])
        .mockReturnValue([makeServer({ name: "fresh-srv", command: "cmd", args: [] })]);
      vi.mocked(store.getToolCount).mockReturnValue(3);
      vi.mocked(store.getLastHarvestedAt).mockReturnValue(recentTimestamp);

      await broker.startup();
      await broker.shutdown();

      expect(mockHarvestTools).not.toHaveBeenCalled();
    });

    it("background refresh failure does not crash", async () => {
      const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace("Z", "").replace("T", " ");
      vi.mocked(registry.listEntries).mockReturnValue([
        { name: "fail-srv", entry: { command: "cmd", args: [] } },
      ]);
      vi.mocked(store.listServers)
        .mockReturnValueOnce([])
        .mockReturnValue([makeServer({ name: "fail-srv", command: "cmd", args: [] })]);
      vi.mocked(store.getToolCount).mockReturnValue(2);
      vi.mocked(store.getLastHarvestedAt).mockReturnValue(oldTimestamp);
      mockHarvestTools.mockRejectedValue(new Error("harvest exploded"));

      // Should not throw
      await broker.startup();
      await broker.shutdown();
    });

    it("shutdown awaits background refresh", async () => {
      const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace("Z", "").replace("T", " ");
      vi.mocked(registry.listEntries).mockReturnValue([
        { name: "srv", entry: { command: "cmd", args: [] } },
      ]);
      vi.mocked(store.listServers)
        .mockReturnValueOnce([])
        .mockReturnValue([makeServer({ name: "srv", command: "cmd", args: [] })]);
      vi.mocked(store.getToolCount).mockReturnValue(1);
      vi.mocked(store.getLastHarvestedAt).mockReturnValue(oldTimestamp);

      let harvestResolved = false;
      mockHarvestTools.mockImplementation(
        () => new Promise((resolve) => {
          setTimeout(() => {
            harvestResolved = true;
            resolve([{ tool_name: "t", description: "T", input_schema: "{}" }]);
          }, 50);
        })
      );

      await broker.startup();
      await broker.shutdown();

      // shutdown should have waited for the background harvest
      expect(harvestResolved).toBe(true);
    });
  });
});
