import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Pool } from "../src/pool.js";
import type { UrlServerRecord } from "../src/store.js";

// ── Transport mocks ─────────────────────────────────────

const mockTransport = {
  onclose: null as (() => void) | null,
  onerror: null as ((err: Error) => void) | null,
  close: vi.fn().mockResolvedValue(undefined),
};

const mockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  getServerVersion: vi.fn(),
};

vi.mock("../src/transport.js", () => ({
  createStdioTransport: vi.fn(),
  createStreamableTransport: vi.fn(),
  createSseTransport: vi.fn(),
  connectUrl: vi.fn(async () => ({ client: mockClient, transport: mockTransport })),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    connect = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    getServerVersion = vi.fn();
  },
}));

const server: UrlServerRecord = {
  name: "test-url",
  url: "https://example.com/mcp",
  headers: { Authorization: "Bearer tok" },
};

describe("Pool URL connection via connectUrl", () => {
  let pool: Pool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTransport.onclose = null;
    mockTransport.onerror = null;
    pool = new Pool();
  });

  afterEach(async () => {
    await pool.closeAll();
  });

  it("delegates to connectUrl for URL servers", async () => {
    const { connectUrl } = await import("../src/transport.js");

    await pool.connectServer(server);

    expect(connectUrl).toHaveBeenCalledWith(server, expect.objectContaining({
      clientName: expect.any(String),
      clientVersion: expect.any(String),
      timeoutMs: expect.any(Number),
      timeoutLabel: expect.stringContaining("test-url"),
    }));
    expect(pool.isConnected("test-url")).toBe(true);
  });

  it("propagates error when connectUrl fails", async () => {
    const { connectUrl } = await import("../src/transport.js");
    vi.mocked(connectUrl).mockRejectedValueOnce(new Error("both transports failed"));

    await expect(pool.connectServer(server)).rejects.toThrow("both transports failed");
    expect(pool.isConnected("test-url")).toBe(false);
  });
});
