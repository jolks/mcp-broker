import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";

// Mock harvester
vi.mock("../src/harvester.js", () => ({
  harvestTools: vi.fn(),
}));

import { harvestTools } from "../src/harvester.js";
import { setupFromConfig } from "../src/setup.js";
import { Registry } from "../src/registry.js";

const mockHarvestTools = vi.mocked(harvestTools);

describe("setupFromConfig with URL-based servers", () => {
  let store: Store;
  let registry: Registry;
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-broker-url-test-"));
    process.env.MCP_BROKER_HOME = tmpDir;
    store = new Store(":memory:");
    registry = new Registry(join(tmpDir, "servers.json"));
  });

  afterEach(() => {
    store.close();
  });

  it("imports config with only URL entries without crashing", async () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          github: {
            url: "https://api.githubcopilot.com/mcp/",
            headers: { Authorization: "Bearer ghp_xxx" },
          },
        },
      })
    );

    mockHarvestTools.mockResolvedValueOnce([
      { tool_name: "create_issue", description: "Create issue", input_schema: "{}" },
    ]);

    const result = await setupFromConfig(registry, store, configPath, { rewrite: false });

    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).toEqual({ name: "github", healthy: true, toolCount: 1 });
  });

  it("imports config with mixed stdio + URL entries", async () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          filesystem: { command: "npx", args: ["@mcp/filesystem"] },
          github: {
            url: "https://api.githubcopilot.com/mcp/",
            headers: { Authorization: "Bearer ghp_xxx" },
          },
        },
      })
    );

    mockHarvestTools
      .mockResolvedValueOnce([
        { tool_name: "read_file", description: "Read file", input_schema: "{}" },
      ])
      .mockResolvedValueOnce([
        { tool_name: "create_issue", description: "Create issue", input_schema: "{}" },
      ]);

    const result = await setupFromConfig(registry, store, configPath, { rewrite: false });

    expect(result.servers).toHaveLength(2);
    const names = result.servers.map((s) => s.name).sort();
    expect(names).toEqual(["filesystem", "github"]);
    expect(result.servers.every((s) => s.healthy)).toBe(true);
  });

  it("URL entry is stored in Store with correct shape", async () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          github: {
            url: "https://api.githubcopilot.com/mcp/",
            headers: { Authorization: "Bearer ghp_xxx" },
          },
        },
      })
    );

    mockHarvestTools.mockResolvedValueOnce([]);

    await setupFromConfig(registry, store, configPath, { rewrite: false });

    const server = store.getServer("github");
    expect(server).toBeDefined();
    expect("url" in server!).toBe(true);
    expect("command" in server!).toBe(false);
    if ("url" in server!) {
      expect(server.url).toBe("https://api.githubcopilot.com/mcp/");
      expect(server.headers).toEqual({ Authorization: "Bearer ghp_xxx" });
    }
  });

  it("Store.upsertServer with URL record round-trips correctly", () => {
    store.upsertServer({
      name: "test-url",
      url: "https://example.com/mcp",
      headers: { "X-Api-Key": "secret" },
    });

    const got = store.getServer("test-url");
    expect(got).toBeDefined();
    expect("url" in got!).toBe(true);
    if ("url" in got!) {
      expect(got.url).toBe("https://example.com/mcp");
      expect(got.headers).toEqual({ "X-Api-Key": "secret" });
    }
  });

  it("harvester receives ServerRecord for URL entry", async () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          remote: {
            url: "https://remote.example.com/mcp",
          },
        },
      })
    );

    mockHarvestTools.mockResolvedValueOnce([]);

    await setupFromConfig(registry, store, configPath, { rewrite: false });

    expect(mockHarvestTools).toHaveBeenCalledWith(
      expect.objectContaining({ name: "remote", url: "https://remote.example.com/mcp" })
    );
  });

  it("registry stores URL entries correctly", async () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          remote: {
            url: "https://remote.example.com/mcp",
            headers: { Authorization: "Bearer tok" },
          },
        },
      })
    );

    mockHarvestTools.mockResolvedValueOnce([]);

    await setupFromConfig(registry, store, configPath, { rewrite: false });

    const entry = registry.getEntry("remote");
    expect(entry).toBeDefined();
    expect("url" in entry!).toBe(true);
    if ("url" in entry!) {
      expect(entry.url).toBe("https://remote.example.com/mcp");
      expect(entry.headers).toEqual({ Authorization: "Bearer tok" });
    }
  });
});
