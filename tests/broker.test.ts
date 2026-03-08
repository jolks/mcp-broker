import { describe, it, expect, vi, beforeEach } from "vitest";
import { Broker } from "../src/broker.js";
import type { Store, SearchResult } from "../src/store.js";
import type { Pool } from "../src/pool.js";
import type { Registry } from "../src/registry.js";
import { makeServer } from "./helpers.js";

// Mock harvester
vi.mock("../src/harvester.js", () => ({
  harvestTools: vi.fn(),
}));

import { harvestTools } from "../src/harvester.js";
const mockHarvestTools = vi.mocked(harvestTools);

function makeStore(): Store {
  return {
    searchTools: vi.fn(),
    upsertServer: vi.fn(),
    upsertTools: vi.fn(),
    getServer: vi.fn(),
    listServers: vi.fn(() => []),
    removeServer: vi.fn(),
    getToolCount: vi.fn(() => 0),
    getToolsForServer: vi.fn(() => []),
    runInTransaction: vi.fn((fn: () => void) => fn()),
    close: vi.fn(),
  } as unknown as Store;
}

function makePool(): Pool {
  return {
    getClient: vi.fn(),
    isConnected: vi.fn(() => false),
    connectServer: vi.fn(),
    connectAll: vi.fn(),
    disconnectServer: vi.fn(),
    closeAll: vi.fn(),
  } as unknown as Pool;
}

function makeRegistry(): Registry {
  return {
    read: vi.fn(() => ({ mcpServers: {} })),
    addServer: vi.fn(),
    removeServer: vi.fn(),
    getEntry: vi.fn(),
    listEntries: vi.fn(() => []),
    importServers: vi.fn(),
  } as unknown as Registry;
}

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

  // ── searchTools ─────────────────────────────────────

  describe("searchTools", () => {
    it("delegates to store.searchTools", () => {
      const mockResults: SearchResult[] = [
        {
          id: "srv__tool",
          server_name: "srv",
          tool_name: "tool",
          description: "A tool",
          input_schema: {},
          rank: -1,
        },
      ];
      vi.mocked(store.searchTools).mockReturnValue(mockResults);

      const results = broker.searchTools("tool");
      expect(store.searchTools).toHaveBeenCalledWith("tool", undefined);
      expect(results).toEqual(mockResults);
    });

    it("passes limit parameter", () => {
      vi.mocked(store.searchTools).mockReturnValue([]);
      broker.searchTools("query", 5);
      expect(store.searchTools).toHaveBeenCalledWith("query", 5);
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
      expect(mockHarvestTools).toHaveBeenCalledWith(server.command, server.args, server.env);
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
    it("enriches with connected status and tool count", () => {
      vi.mocked(store.listServers).mockReturnValue([
        makeServer({ name: "a" }),
        makeServer({ name: "b" }),
      ]);
      vi.mocked(pool.isConnected).mockImplementation((name: string) => name === "a");
      vi.mocked(store.getToolCount).mockImplementation((name: string) =>
        name === "a" ? 2 : 0
      );

      const result = broker.listServers();
      expect(result).toEqual([
        { name: "a", connected: true, toolCount: 2 },
        { name: "b", connected: false, toolCount: 0 },
      ]);
    });

    it("returns empty array when no servers", () => {
      vi.mocked(store.listServers).mockReturnValue([]);
      expect(broker.listServers()).toEqual([]);
    });
  });

  // ── getServer ──────────────────────────────────────

  describe("getServer", () => {
    it("returns enriched server detail", () => {
      vi.mocked(store.getServer).mockReturnValue(
        makeServer({ name: "github", command: "npx", args: ["@mcp/github"], env: { TOKEN: "abc" } })
      );
      vi.mocked(pool.isConnected).mockReturnValue(true);
      vi.mocked(store.getToolCount).mockReturnValue(3);
      vi.mocked(store.getToolsForServer).mockReturnValue([
        { tool_name: "create_issue", description: "Create an issue" },
        { tool_name: "list_repos", description: "List repos" },
        { tool_name: "get_pr", description: "Get a PR" },
      ]);

      const result = broker.getServer("github");
      expect(result).toEqual({
        name: "github",
        command: "npx",
        args: ["@mcp/github"],
        env: { TOKEN: "abc" },
        connected: true,
        toolCount: 3,
        tools: [
          { tool_name: "create_issue", description: "Create an issue" },
          { tool_name: "list_repos", description: "List repos" },
          { tool_name: "get_pr", description: "Get a PR" },
        ],
      });
    });

    it("returns undefined for missing server", () => {
      vi.mocked(store.getServer).mockReturnValue(undefined);
      expect(broker.getServer("missing")).toBeUndefined();
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
      expect(mockHarvestTools).toHaveBeenCalledWith("deno", ["old.js"], undefined);
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
      expect(mockHarvestTools).toHaveBeenCalledWith("node", ["server.js"], undefined);
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
      vi.mocked(registry.listEntries).mockReturnValue([
        { name: "a", entry: { command: "cmd-a", args: [] } },
      ]);
      vi.mocked(store.listServers).mockReturnValue([]);
      vi.mocked(store.getToolCount).mockReturnValue(5); // already has tools

      await broker.startup();

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

      expect(mockHarvestTools).toHaveBeenCalledWith("cmd-a", [], undefined);
      expect(store.upsertTools).toHaveBeenCalled();
    });

    it("shutdown closes pool and store", async () => {
      await broker.shutdown();
      expect(pool.closeAll).toHaveBeenCalled();
      expect(store.close).toHaveBeenCalled();
    });
  });
});
