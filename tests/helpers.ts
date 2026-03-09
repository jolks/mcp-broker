import { vi } from "vitest";
import type { ServerRecord, Store } from "../src/store.js";
import type { Pool } from "../src/pool.js";
import type { Registry } from "../src/registry.js";

export function makeServer(overrides: Partial<ServerRecord> = {}): ServerRecord {
  return {
    name: "test-server",
    command: "node",
    args: ["server.js"],
    env: undefined,
    ...overrides,
  };
}

export function makeStore(): Store {
  return {
    searchTools: vi.fn(),
    upsertServer: vi.fn(),
    upsertTools: vi.fn(),
    getServer: vi.fn(),
    listServers: vi.fn(() => []),
    removeServer: vi.fn(),
    getToolCount: vi.fn(() => 0),
    getToolsForServer: vi.fn(() => []),
    getLastHarvestedAt: vi.fn(() => undefined),
    runInTransaction: vi.fn((fn: () => void) => fn()),
    close: vi.fn(),
  } as unknown as Store;
}

export function makePool(): Pool {
  return {
    getClient: vi.fn(),
    isConnected: vi.fn(() => false),
    connectServer: vi.fn(),
    connectAll: vi.fn(),
    disconnectServer: vi.fn(),
    closeAll: vi.fn(),
    getServerVersion: vi.fn(() => undefined),
  } as unknown as Pool;
}

export function makeRegistry(): Registry {
  return {
    read: vi.fn(() => ({ mcpServers: {} })),
    addServer: vi.fn(),
    removeServer: vi.fn(),
    getEntry: vi.fn(),
    listEntries: vi.fn(() => []),
    importServers: vi.fn(),
  } as unknown as Registry;
}
