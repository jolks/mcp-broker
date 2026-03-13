import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { type ServerRecord, isUrlServer } from "./store.js";
import { createStdioTransport, connectUrl } from "./transport.js";
import { logger } from "./logger.js";
import { VERSION, HARVESTER_NAME, HARVEST_TIMEOUT_MS, raceTimeout } from "./config.js";

export interface HarvestedTool {
  tool_name: string;
  description: string;
  input_schema: string; // JSON string
}

/**
 * Connect a URL-based server with Streamable HTTP → SSE fallback.
 * Returns the connected client and transport for cleanup.
 */
async function connectForHarvest(
  server: ServerRecord,
  label: string,
): Promise<{ client: Client; transport: Transport }> {
  if (!isUrlServer(server)) {
    const transport = createStdioTransport(server);
    const client = new Client({ name: HARVESTER_NAME, version: VERSION });
    await raceTimeout(
      client.connect(transport),
      HARVEST_TIMEOUT_MS,
      `Connecting to ${label} timed out`,
    );
    return { client, transport };
  }

  return connectUrl(server, {
    clientName: HARVESTER_NAME,
    clientVersion: VERSION,
    timeoutMs: HARVEST_TIMEOUT_MS,
    timeoutLabel: `Connecting to ${label} timed out`,
  });
}

export async function harvestTools(
  server: ServerRecord
): Promise<HarvestedTool[]> {
  const label = isUrlServer(server) ? server.url : `${server.command} ${server.args.join(" ")}`;
  let transport: Transport | undefined;

  try {
    const connected = await connectForHarvest(server, label);
    const client = connected.client;
    transport = connected.transport;

    // Collect all tools with pagination
    const allTools: Tool[] = [];
    let cursor: string | undefined;

    do {
      const result = await raceTimeout(
        client.listTools(cursor ? { cursor } : undefined),
        HARVEST_TIMEOUT_MS,
        `Listing tools from ${label} timed out`
      );
      allTools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);

    logger.info(`Harvested ${allTools.length} tools from ${label}`);

    await client.close();

    return allTools.map((t) => ({
      tool_name: t.name,
      description: t.description ?? "",
      input_schema: JSON.stringify(t.inputSchema ?? {}),
    }));
  } catch (err) {
    logger.error(`Failed to harvest tools from ${label}: ${err}`);
    throw err;
  } finally {
    try {
      await transport?.close();
    } catch {
      // Best-effort cleanup
    }
  }
}
