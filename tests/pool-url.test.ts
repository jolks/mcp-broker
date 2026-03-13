import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Pool } from "../src/pool.js";
import type { UrlServerRecord } from "../src/store.js";

// ── Transport mocks ─────────────────────────────────────

let streamableConnectShouldFail = false;
let sseConnectShouldFail = false;

const transportInstances: Array<{
  type: string;
  onclose: (() => void) | null;
  onerror: ((err: Error) => void) | null;
  close: ReturnType<typeof vi.fn>;
}> = [];

function makeMockTransport(type: string) {
  const t = {
    type,
    onclose: null as (() => void) | null,
    onerror: null as ((err: Error) => void) | null,
    close: vi.fn().mockResolvedValue(undefined),
  };
  transportInstances.push(t);
  return t;
}

vi.mock("../src/transport.js", () => ({
  createStdioTransport: vi.fn(),
  createStreamableTransport: vi.fn(() => makeMockTransport("streamable")),
  createSseTransport: vi.fn(() => makeMockTransport("sse")),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  return {
    Client: class MockClient {
      connect = vi.fn(async (transport: { type?: string }) => {
        if (transport.type === "streamable" && streamableConnectShouldFail) {
          throw new Error("streamable connect failed");
        }
        if (transport.type === "sse" && sseConnectShouldFail) {
          throw new Error("sse connect failed");
        }
      });
      close = vi.fn().mockResolvedValue(undefined);
      getServerVersion = vi.fn();
    },
  };
});

const server: UrlServerRecord = {
  name: "test-url",
  url: "https://example.com/mcp",
  headers: { Authorization: "Bearer tok" },
};

describe("Pool URL connection fallback", () => {
  let pool: Pool;

  beforeEach(() => {
    vi.clearAllMocks();
    transportInstances.length = 0;
    streamableConnectShouldFail = false;
    sseConnectShouldFail = false;
    pool = new Pool();
  });

  afterEach(async () => {
    await pool.closeAll();
  });

  it("succeeds with Streamable HTTP — no SSE fallback", async () => {
    await pool.connectServer(server);

    expect(pool.isConnected("test-url")).toBe(true);
    // Only one transport created (streamable)
    expect(transportInstances).toHaveLength(1);
    expect(transportInstances[0].type).toBe("streamable");
  });

  it("falls back to SSE when Streamable HTTP connect fails", async () => {
    streamableConnectShouldFail = true;

    await pool.connectServer(server);

    expect(pool.isConnected("test-url")).toBe(true);
    // Two transports created: streamable (failed) + SSE (succeeded)
    expect(transportInstances).toHaveLength(2);
    expect(transportInstances[0].type).toBe("streamable");
    expect(transportInstances[1].type).toBe("sse");
  });

  it("closes failed streamable transport during fallback", async () => {
    streamableConnectShouldFail = true;

    await pool.connectServer(server);

    expect(transportInstances[0].close).toHaveBeenCalled();
  });

  it("propagates error when both transports fail", async () => {
    streamableConnectShouldFail = true;
    sseConnectShouldFail = true;

    await expect(pool.connectServer(server)).rejects.toThrow("sse connect failed");
    expect(pool.isConnected("test-url")).toBe(false);
  });

  it("preserves headers through fallback", async () => {
    const { createStreamableTransport, createSseTransport } = await import("../src/transport.js");
    streamableConnectShouldFail = true;

    await pool.connectServer(server);

    expect(createStreamableTransport).toHaveBeenCalledWith(server);
    expect(createSseTransport).toHaveBeenCalledWith(server);
  });
});
