import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Store } from "../src/store.js";
import type { Registry } from "../src/registry.js";

// Mock harvester
vi.mock("../src/harvester.js", () => ({
  harvestTools: vi.fn(),
}));

import { harvestTools } from "../src/harvester.js";
import { setupFromConfig } from "../src/setup.js";

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
    close: vi.fn(),
  } as unknown as Store;
}

function makeRegistry(): Registry {
  return {
    read: vi.fn(() => ({ mcpServers: {} })),
    addServer: vi.fn(),
    removeServer: vi.fn(),
    listEntries: vi.fn(() => []),
    importServers: vi.fn(),
  } as unknown as Registry;
}

describe("setupFromConfig", () => {
  let store: Store;
  let registry: Registry;
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeStore();
    registry = makeRegistry();
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-broker-setup-test-"));
    process.env.MCP_BROKER_HOME = tmpDir;
  });

  it("sets up servers and tracks health (one pass, one fail)", async () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["@mcp/github"] },
          slack: { command: "npx", args: ["@mcp/slack"] },
        },
      })
    );

    mockHarvestTools
      .mockResolvedValueOnce([
        { tool_name: "create_issue", description: "Create issue", input_schema: "{}" },
      ])
      .mockRejectedValueOnce(new Error("Connection refused"));

    const result = await setupFromConfig(registry, store, configPath, { rewrite: false });

    expect(result.servers).toHaveLength(2);
    expect(result.servers[0]).toEqual({ name: "github", healthy: true, toolCount: 1 });
    expect(result.servers[1]).toEqual({
      name: "slack",
      healthy: false,
      toolCount: 0,
      error: "Connection refused",
    });
  });

  it("writes to registry before indexing in SQLite", async () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["@mcp/github"] },
          slack: { command: "npx", args: ["@mcp/slack"] },
        },
      })
    );
    mockHarvestTools.mockResolvedValue([]);

    await setupFromConfig(registry, store, configPath, { rewrite: false });

    expect(registry.importServers).toHaveBeenCalledWith({
      github: { command: "npx", args: ["@mcp/github"] },
      slack: { command: "npx", args: ["@mcp/slack"] },
    });
  });

  it("skips mcp-broker entry", async () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          "mcp-broker": { command: "npx", args: ["-y", "mcp-broker", "serve"] },
          github: { command: "npx", args: ["@mcp/github"] },
        },
      })
    );

    mockHarvestTools.mockResolvedValueOnce([]);

    const result = await setupFromConfig(registry, store, configPath, { rewrite: false });

    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].name).toBe("github");
    expect(store.upsertServer).toHaveBeenCalledTimes(1);
    // mcp-broker should not be imported to registry
    expect(registry.importServers).toHaveBeenCalledWith({
      github: { command: "npx", args: ["@mcp/github"] },
    });
  });

  it("returns empty for empty config", async () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));

    const result = await setupFromConfig(registry, store, configPath);

    expect(result.servers).toEqual([]);
    expect(result.backupPath).toBe("");
    expect(result.rewritten).toBe(false);
  });

  it("creates backup before importing", async () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { a: { command: "echo" } } })
    );
    mockHarvestTools.mockResolvedValueOnce([]);

    const result = await setupFromConfig(registry, store, configPath, { rewrite: false });

    expect(result.backupPath).toContain(".bak");
  });

  it("rewrites config when rewrite: true", async () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { a: { command: "echo" } } })
    );
    mockHarvestTools.mockResolvedValueOnce([]);

    const result = await setupFromConfig(registry, store, configPath, { rewrite: true });

    expect(result.rewritten).toBe(true);
    const rewritten = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(rewritten.mcpServers).toHaveProperty("mcp-broker");
  });

  it("skips rewrite when rewrite: false", async () => {
    const configPath = join(tmpDir, "config.json");
    const original = JSON.stringify({ mcpServers: { a: { command: "echo" } } });
    writeFileSync(configPath, original);
    mockHarvestTools.mockResolvedValueOnce([]);

    const result = await setupFromConfig(registry, store, configPath, { rewrite: false });

    expect(result.rewritten).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });
});
