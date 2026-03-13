import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UrlServerRecord } from "../src/store.js";

// ── Mocks at SDK level ──────────────────────────────────

let streamableConnectShouldFail = false;
let sseConnectShouldFail = false;

const transportInstances: Array<{
  type: string;
  close: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdio {},
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamable {
    type = "streamable";
    close = vi.fn().mockResolvedValue(undefined);
    constructor() {
      transportInstances.push(this as unknown as typeof transportInstances[0]);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSE {
    type = "sse";
    close = vi.fn().mockResolvedValue(undefined);
    constructor() {
      transportInstances.push(this as unknown as typeof transportInstances[0]);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    connect = vi.fn(async function (this: any, transport: { type?: string }) {
      if (transport.type === "streamable" && streamableConnectShouldFail) {
        throw new Error("streamable connect failed");
      }
      if (transport.type === "sse" && sseConnectShouldFail) {
        throw new Error("sse connect failed");
      }
    });
    close = vi.fn().mockResolvedValue(undefined);
  },
}));

import { connectUrl } from "../src/transport.js";

const server: UrlServerRecord = {
  name: "test-url",
  url: "https://example.com/mcp",
  headers: { Authorization: "Bearer tok" },
};

const opts = {
  clientName: "test-client",
  clientVersion: "1.0.0",
  timeoutMs: 5000,
  timeoutLabel: "test timeout",
};

describe("connectUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transportInstances.length = 0;
    streamableConnectShouldFail = false;
    sseConnectShouldFail = false;
  });

  it("succeeds with Streamable HTTP — no SSE fallback", async () => {
    const result = await connectUrl(server, opts);

    expect(result.client).toBeDefined();
    expect(result.transport).toBeDefined();
    // Only streamable transport created
    expect(transportInstances).toHaveLength(1);
    expect(transportInstances[0].type).toBe("streamable");
  });

  it("falls back to SSE when Streamable HTTP fails", async () => {
    streamableConnectShouldFail = true;

    const result = await connectUrl(server, opts);

    expect(result.client).toBeDefined();
    expect(result.transport).toBeDefined();
    // Both transports created: streamable (failed) + SSE (succeeded)
    expect(transportInstances).toHaveLength(2);
    expect(transportInstances[0].type).toBe("streamable");
    expect(transportInstances[1].type).toBe("sse");
  });

  it("closes failed streamable transport during fallback", async () => {
    streamableConnectShouldFail = true;

    await connectUrl(server, opts);

    expect(transportInstances[0].close).toHaveBeenCalled();
  });

  it("propagates error when both transports fail", async () => {
    streamableConnectShouldFail = true;
    sseConnectShouldFail = true;

    await expect(connectUrl(server, opts)).rejects.toThrow();
    // Both transports were created
    expect(transportInstances).toHaveLength(2);
  });

  it("returns SSE transport as the active transport on fallback", async () => {
    streamableConnectShouldFail = true;

    const result = await connectUrl(server, opts);

    // The returned transport should be the SSE one
    expect(result.transport).toBe(transportInstances[1]);
  });
});
