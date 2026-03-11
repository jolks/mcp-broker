import { Store } from "./store.js";
import type { ServerRecord } from "./store.js";
import { Registry } from "./registry.js";
import { readConfig, backupConfig, rewriteConfigForBroker, isUrlEntry } from "./client-config.js";
import { harvestTools } from "./harvester.js";
import { logger } from "./logger.js";
import { SERVER_NAME, getErrorMessage } from "./config.js";

export interface ServerSetupResult {
  name: string;
  healthy: boolean;
  toolCount: number;
  error?: string;
}

export interface SetupResult {
  configPath: string;
  backupPath: string;
  servers: ServerSetupResult[];
  rewritten: boolean;
}

export async function setupFromConfig(
  registry: Registry,
  store: Store,
  configPath: string,
  options: { rewrite: boolean } = { rewrite: true }
): Promise<SetupResult> {
  const config = readConfig(configPath);
  const entries = config.mcpServers ?? {};
  const names = Object.keys(entries).filter((n) => n !== SERVER_NAME);

  if (names.length === 0) {
    return { configPath, backupPath: "", servers: [], rewritten: false };
  }

  const backupPath = backupConfig(configPath);

  // Write to registry (source of truth)
  const toImport: Record<string, typeof entries[string]> = {};
  for (const name of names) {
    toImport[name] = entries[name];
  }
  registry.importServers(toImport);

  for (const name of names) {
    const entry = entries[name];
    const record: ServerRecord = isUrlEntry(entry)
      ? { name, url: entry.url, headers: entry.headers }
      : { name, command: entry.command, args: entry.args ?? [], env: entry.env };
    store.upsertServer(record);
  }

  // Harvest tools in parallel
  const results = await Promise.allSettled(
    names.map(async (name) => {
      const entry = entries[name];
      const record: ServerRecord = isUrlEntry(entry)
        ? { name, url: entry.url, headers: entry.headers }
        : { name, command: entry.command, args: entry.args ?? [], env: entry.env };
      const tools = await harvestTools(record);
      store.upsertTools(name, tools);
      return { name, toolCount: tools.length };
    })
  );

  const servers: ServerSetupResult[] = results.map((r, i) => {
    if (r.status === "fulfilled") {
      return { name: r.value.name, healthy: true, toolCount: r.value.toolCount };
    }
    const message = getErrorMessage(r.reason);
    logger.warn(`Failed to harvest tools for "${names[i]}": ${message}`);
    return { name: names[i], healthy: false, toolCount: 0, error: message };
  });

  let rewritten = false;
  if (options.rewrite) {
    rewriteConfigForBroker(configPath);
    rewritten = true;
  }

  return { configPath, backupPath, servers, rewritten };
}
