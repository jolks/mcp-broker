import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
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

/**
 * Create a transport for a URL-based server.
 * Tries Streamable HTTP first, falls back to SSE on failure (per MCP spec).
 */
export async function createUrlTransport(
  server: UrlServerRecord
): Promise<Transport> {
  const url = new URL(server.url);
  const headers = server.headers;

  // Try Streamable HTTP first
  try {
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: headers ? { headers } : undefined,
    });
    return transport;
  } catch {
    // Fall back to SSE
    return new SSEClientTransport(url, {
      requestInit: headers ? { headers } : undefined,
    });
  }
}
