import { Store } from "./store.js";
import { Registry } from "./registry.js";
import { readConfig, backupConfig, rewriteConfigForBroker } from "./client-config.js";
import { harvestTools } from "./harvester.js";
import { logger } from "./logger.js";

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
  const names = Object.keys(entries).filter((n) => n !== "mcp-broker");

  if (names.length === 0) {
    return { configPath, backupPath: "", servers: [], rewritten: false };
  }

  const backupPath = backupConfig(configPath);

  // Write to registry (source of truth)
  const toImport: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};
  for (const name of names) {
    toImport[name] = entries[name];
  }
  registry.importServers(toImport);

  const servers: ServerSetupResult[] = [];

  for (const name of names) {
    const entry = entries[name];
    store.upsertServer({
      name,
      command: entry.command,
      args: entry.args ?? [],
      env: entry.env,
    });

    try {
      const tools = await harvestTools(entry.command, entry.args, entry.env);
      store.upsertTools(name, tools);
      servers.push({ name, healthy: true, toolCount: tools.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to harvest tools for "${name}": ${message}`);
      servers.push({ name, healthy: false, toolCount: 0, error: message });
    }
  }

  let rewritten = false;
  if (options.rewrite) {
    rewriteConfigForBroker(configPath);
    rewritten = true;
  }

  return { configPath, backupPath, servers, rewritten };
}
