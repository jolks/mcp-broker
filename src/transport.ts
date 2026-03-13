import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { StdioServerRecord, UrlServerRecord } from "./store.js";
import { buildEnv, raceTimeout } from "./config.js";
import { logger } from "./logger.js";

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

export interface ConnectUrlOptions {
  clientName: string;
  clientVersion: string;
  timeoutMs: number;
  timeoutLabel: string;
}

/**
 * Connect to a URL-based server, trying Streamable HTTP first
 * and falling back to SSE (per MCP spec).
 */
export async function connectUrl(
  server: UrlServerRecord,
  opts: ConnectUrlOptions,
): Promise<{ client: Client; transport: Transport }> {
  // Try Streamable HTTP first
  let transport: Transport = createStreamableTransport(server);
  let client = new Client({ name: opts.clientName, version: opts.clientVersion });
  try {
    await raceTimeout(client.connect(transport), opts.timeoutMs, opts.timeoutLabel);
    return { client, transport };
  } catch {
    logger.info(`Streamable HTTP failed for "${server.name}", trying SSE`);
    try { await transport.close(); } catch { /* best-effort */ }
  }
  // Fall back to SSE
  transport = createSseTransport(server);
  client = new Client({ name: opts.clientName, version: opts.clientVersion });
  await raceTimeout(client.connect(transport), opts.timeoutMs, `${opts.timeoutLabel} (SSE fallback)`);
  return { client, transport };
}
