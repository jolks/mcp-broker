import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { type ServerRecord, isUrlServer } from "./store.js";
import { createStdioTransport, createUrlTransport } from "./transport.js";
import { logger } from "./logger.js";
import { VERSION, HARVESTER_NAME, HARVEST_TIMEOUT_MS, raceTimeout } from "./config.js";

export interface HarvestedTool {
  tool_name: string;
  description: string;
  input_schema: string; // JSON string
}

export async function harvestTools(
  server: ServerRecord
): Promise<HarvestedTool[]> {
  let transport: Transport | undefined;
  const label = isUrlServer(server) ? server.url : `${server.command} ${server.args.join(" ")}`;

  try {
    transport = isUrlServer(server)
      ? await createUrlTransport(server)
      : createStdioTransport(server);

    const client = new Client({ name: HARVESTER_NAME, version: VERSION });

    // Race against timeout
    await raceTimeout(
      client.connect(transport),
      HARVEST_TIMEOUT_MS,
      `Connecting to ${label} timed out`
    );

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
