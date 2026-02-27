import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { Registry } from "../src/registry.js";
import { Pool } from "../src/pool.js";
import { Broker } from "../src/broker.js";
import { setupFromConfig } from "../src/setup.js";

const FIXTURE = resolve(import.meta.dirname, "fixtures/echo-server.ts");

describe("Registry integration", { timeout: 60_000 }, () => {
  let tmpDir: string;
  let store: Store;
  let registry: Registry;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-broker-reg-int-"));
    process.env.MCP_BROKER_HOME = tmpDir;
    registry = new Registry(join(tmpDir, "servers.json"));
    store = new Store(join(tmpDir, "broker.db"));
  });

  afterEach(() => {
    store.close();
  });

  it("setup writes servers.json and indexes tools in SQLite", async () => {
    // Write a config file with echo server
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        echo: { command: "npx", args: ["tsx", FIXTURE] },
      },
    }));

    await setupFromConfig(registry, store, configPath, { rewrite: false });

    // Verify servers.json exists with the right entries
    const data = registry.read();
    expect(data.mcpServers.echo).toBeDefined();
    expect(data.mcpServers.echo.command).toBe("npx");

    // Verify tools indexed in SQLite
    const toolCount = store.getToolCount("echo");
    expect(toolCount).toBe(2);

    // Verify tools are searchable
    const results = store.searchTools("echo");
    expect(results.length).toBeGreaterThan(0);
  });

  it("startup reads from servers.json and harvests tools into fresh DB", async () => {
    // Seed servers.json manually
    registry.addServer("echo", { command: "npx", args: ["tsx", FIXTURE] });

    // store is fresh (empty DB) — no tools indexed yet
    expect(store.getToolCount("echo")).toBe(0);

    const pool = new Pool();
    const broker = new Broker(store, pool, registry);

    await broker.startup();

    // Verify tools were harvested from servers.json
    expect(store.getToolCount("echo")).toBe(2);
    const results = store.searchTools("echo");
    expect(results.length).toBeGreaterThan(0);

    await pool.closeAll();
  });

  it("DB rebuild from servers.json: delete DB, re-harvest on startup", async () => {
    // Step 1: setup populates both servers.json and DB
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        echo: { command: "npx", args: ["tsx", FIXTURE] },
      },
    }));

    await setupFromConfig(registry, store, configPath, { rewrite: false });
    expect(store.getToolCount("echo")).toBe(2);

    // Step 2: close and delete DB
    store.close();
    const dbFile = join(tmpDir, "broker.db");
    if (existsSync(dbFile)) unlinkSync(dbFile);
    // Also clean up WAL/SHM files
    try { unlinkSync(dbFile + "-wal"); } catch { /* ignore */ }
    try { unlinkSync(dbFile + "-shm"); } catch { /* ignore */ }

    // Step 3: create new Store (fresh DB) and startup
    store = new Store(join(tmpDir, "broker.db"));
    expect(store.getToolCount("echo")).toBe(0);

    const pool = new Pool();
    const broker = new Broker(store, pool, registry);

    await broker.startup();

    // Step 4: verify tools re-harvested from servers.json
    expect(store.getToolCount("echo")).toBe(2);
    const results = store.searchTools("echo");
    expect(results.length).toBeGreaterThan(0);

    await pool.closeAll();
  });
});
