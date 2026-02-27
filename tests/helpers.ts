import type { ServerRecord } from "../src/store.js";

export function makeServer(overrides: Partial<ServerRecord> = {}): ServerRecord {
  return {
    name: "test-server",
    command: "node",
    args: ["server.js"],
    env: undefined,
    ...overrides,
  };
}
