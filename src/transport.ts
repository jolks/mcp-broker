import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { StdioServerRecord, UrlServerRecord } from "./store.js";
import { buildEnv } from "./config.js";

export function createStdioTransport(server: StdioServerRecord): StdioClientTransport {
  return new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: buildEnv(server.env),
    stderr: "pipe",
  });
}

export function createStreamableTransport(server: UrlServerRecord): StreamableHTTPClientTransport {
  const url = new URL(server.url);
  return new StreamableHTTPClientTransport(url, {
    requestInit: server.headers ? { headers: server.headers } : undefined,
  });
}

export function createSseTransport(server: UrlServerRecord): SSEClientTransport {
  const url = new URL(server.url);
  return new SSEClientTransport(url, {
    requestInit: server.headers ? { headers: server.headers } : undefined,
  });
}
