import { describe, it, expect, vi, beforeEach } from "vitest";

// Track constructor calls
const stdioArgs: unknown[] = [];
const streamableArgs: unknown[][] = [];
const sseArgs: unknown[][] = [];

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdio {
    constructor(opts: unknown) { stdioArgs.push(opts); }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamable {
    constructor(url: unknown, opts: unknown) { streamableArgs.push([url, opts]); }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSE {
    constructor(url: unknown, opts: unknown) { sseArgs.push([url, opts]); }
  },
}));

import { createStdioTransport, createStreamableTransport, createSseTransport } from "../src/transport.js";
import type { StdioServerRecord, UrlServerRecord } from "../src/store.js";

describe("transport factories", () => {
  beforeEach(() => {
    stdioArgs.length = 0;
    streamableArgs.length = 0;
    sseArgs.length = 0;
  });

  describe("createStdioTransport", () => {
    it("passes command, args, and env", () => {
      const server: StdioServerRecord = { name: "s", command: "node", args: ["server.js"], env: { KEY: "val" } };
      createStdioTransport(server);
      expect(stdioArgs).toHaveLength(1);
      const opts = stdioArgs[0] as Record<string, unknown>;
      expect(opts.command).toBe("node");
      expect(opts.args).toEqual(["server.js"]);
      expect(opts.stderr).toBe("pipe");
    });

    it("passes undefined env when not set", () => {
      const server: StdioServerRecord = { name: "s", command: "node", args: [] };
      createStdioTransport(server);
      const opts = stdioArgs[0] as Record<string, unknown>;
      expect(opts.env).toBeUndefined();
    });
  });

  describe("createStreamableTransport", () => {
    it("passes URL and headers", () => {
      const server: UrlServerRecord = { name: "s", url: "https://example.com/mcp", headers: { Authorization: "Bearer tok" } };
      createStreamableTransport(server);
      expect(streamableArgs).toHaveLength(1);
      const [url, opts] = streamableArgs[0] as [URL, Record<string, unknown>];
      expect(url.href).toBe("https://example.com/mcp");
      expect(opts).toEqual({ requestInit: { headers: { Authorization: "Bearer tok" } } });
    });

    it("omits requestInit headers when undefined", () => {
      const server: UrlServerRecord = { name: "s", url: "https://example.com/mcp" };
      createStreamableTransport(server);
      const [, opts] = streamableArgs[0] as [URL, Record<string, unknown>];
      expect(opts).toEqual({ requestInit: undefined });
    });
  });

  describe("createSseTransport", () => {
    it("passes URL and headers", () => {
      const server: UrlServerRecord = { name: "s", url: "https://example.com/sse", headers: { Auth: "tok" } };
      createSseTransport(server);
      expect(sseArgs).toHaveLength(1);
      const [url, opts] = sseArgs[0] as [URL, Record<string, unknown>];
      expect(url.href).toBe("https://example.com/sse");
      expect(opts).toEqual({ requestInit: { headers: { Auth: "tok" } } });
    });

    it("omits requestInit headers when undefined", () => {
      const server: UrlServerRecord = { name: "s", url: "https://example.com/sse" };
      createSseTransport(server);
      const [, opts] = sseArgs[0] as [URL, Record<string, unknown>];
      expect(opts).toEqual({ requestInit: undefined });
    });
  });
});
