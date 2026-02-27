import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "./logger.js";
import { VERSION, HARVESTER_NAME, HARVEST_TIMEOUT_MS, buildEnv, raceTimeout } from "./config.js";

export interface HarvestedTool {
  tool_name: string;
  description: string;
  input_schema: string; // JSON string
}

export async function harvestTools(
  command: string,
  args: string[] = [],
  env?: Record<string, string>
): Promise<HarvestedTool[]> {
  let transport: StdioClientTransport | undefined;

  try {
    transport = new StdioClientTransport({
      command,
      args,
      env: buildEnv(env),
      stderr: "pipe",
    });

    const client = new Client({ name: HARVESTER_NAME, version: VERSION });

    // Race against timeout
    await raceTimeout(
      client.connect(transport),
      HARVEST_TIMEOUT_MS,
      `Connecting to ${command} timed out`
    );

    // Collect all tools with pagination
    const allTools: Tool[] = [];
    let cursor: string | undefined;

    do {
      const result = await raceTimeout(
        client.listTools(cursor ? { cursor } : undefined),
        HARVEST_TIMEOUT_MS,
        `Listing tools from ${command} timed out`
      );
      allTools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);

    logger.info(`Harvested ${allTools.length} tools from ${command} ${args.join(" ")}`);

    await client.close();

    return allTools.map((t) => ({
      tool_name: t.name,
      description: t.description ?? "",
      input_schema: JSON.stringify(t.inputSchema ?? {}),
    }));
  } catch (err) {
    logger.error(`Failed to harvest tools from ${command}: ${err}`);
    throw err;
  } finally {
    try {
      await transport?.close();
    } catch {
      // Best-effort cleanup
    }
  }
}
