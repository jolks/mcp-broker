import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Store, type ServerRecord, type SearchResult, type ToolSummary } from "./store.js";
import { Pool } from "./pool.js";
import { Registry } from "./registry.js";
import { harvestTools } from "./harvester.js";
import { logger } from "./logger.js";

export interface ToolInvocation {
  server_name: string;
  tool_name: string;
  arguments?: Record<string, unknown>;
}

export interface ServerUpdate {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ServerDetail {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  connected: boolean;
  toolCount: number;
  tools: ToolSummary[];
}

export class Broker {
  private store: Store;
  private pool: Pool;
  private registry: Registry;

  constructor(store: Store, pool: Pool, registry: Registry) {
    this.store = store;
    this.pool = pool;
    this.registry = registry;
  }

  // ── Search ─────────────────────────────────────────────

  searchTools(query: string, limit?: number): SearchResult[] {
    return this.store.searchTools(query, limit);
  }

  // ── Call Tools ──────────────────────────────────────────

  async callTools(invocations: ToolInvocation[]): Promise<CallToolResult> {
    const results = await Promise.allSettled(
      invocations.map((inv) => this.callTool(inv.server_name, inv.tool_name, inv.arguments ?? {}))
    );

    const output = invocations.map((inv, i) => {
      const r = results[i];
      return {
        server_name: inv.server_name,
        tool_name: inv.tool_name,
        ...(r.status === "fulfilled"
          ? r.value
          : { content: [{ type: "text", text: String(r.reason) }], isError: true }),
      };
    });

    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
    };
  }

  private async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    const client = this.pool.getClient(serverName);
    if (!client) {
      return {
        content: [
          {
            type: "text",
            text: `Server "${serverName}" is not connected. Try refresh_tools or wait for reconnect.`,
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await client.callTool({
        name: toolName,
        arguments: args,
      });
      return result as CallToolResult;
    } catch (err) {
      logger.error(`Error calling ${toolName} on ${serverName}: ${err}`);
      return {
        content: [
          {
            type: "text",
            text: `Error calling ${toolName}: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  // ── Server Management ─────────────────────────────────

  async addServer(server: ServerRecord): Promise<{ toolCount: number }> {
    // Write to registry first (source of truth)
    this.registry.addServer(server.name, {
      command: server.command,
      args: server.args,
      env: server.env,
    });

    this.store.upsertServer(server);

    const tools = await harvestTools(server.command, server.args, server.env);
    this.store.upsertTools(server.name, tools);

    try {
      await this.pool.connectServer(server);
    } catch (err) {
      logger.error(`Failed to connect to newly added server "${server.name}": ${err}`);
    }

    return { toolCount: tools.length };
  }

  async removeServer(name: string): Promise<void> {
    // Remove from registry first (source of truth)
    this.registry.removeServer(name);

    await this.pool.disconnectServer(name);
    this.store.removeServer(name);
    logger.info(`Removed server "${name}"`);
  }

  listServers(): Array<{ name: string; connected: boolean; toolCount: number }> {
    const servers = this.store.listServers();
    return servers.map((s) => ({
      name: s.name,
      connected: this.pool.isConnected(s.name),
      toolCount: this.store.getToolCount(s.name),
    }));
  }

  getServer(name: string): ServerDetail | undefined {
    const server = this.store.getServer(name);
    if (!server) return undefined;
    return {
      name: server.name,
      command: server.command,
      args: server.args,
      env: server.env,
      connected: this.pool.isConnected(server.name),
      toolCount: this.store.getToolCount(server.name),
      tools: this.store.getToolsForServer(server.name),
    };
  }

  async updateServer(name: string, updates: ServerUpdate): Promise<{ toolCount: number }> {
    const existing = this.store.getServer(name);
    if (!existing) {
      throw new Error(`Server "${name}" not found`);
    }

    const merged: ServerRecord = {
      name,
      command: updates.command ?? existing.command,
      args: updates.args ?? existing.args,
      env: updates.env ?? existing.env,
    };

    // Write to registry (source of truth) and store
    this.registry.addServer(name, {
      command: merged.command,
      args: merged.args,
      env: merged.env,
    });
    this.store.upsertServer(merged);

    // Disconnect, re-harvest, reconnect
    await this.pool.disconnectServer(name);
    const tools = await harvestTools(merged.command, merged.args, merged.env);
    this.store.upsertTools(name, tools);
    try {
      await this.pool.connectServer(merged);
    } catch (err) {
      logger.error(`Failed to reconnect "${name}" after update: ${err}`);
    }

    return { toolCount: tools.length };
  }

  async refreshTools(serverName?: string): Promise<void> {
    // Read server definitions from registry (source of truth)
    const entries = this.registry.listEntries();

    const servers = serverName
      ? entries.filter((e) => e.name === serverName)
      : entries;

    for (const { name, entry } of servers) {
      try {
        const tools = await harvestTools(entry.command, entry.args, entry.env);
        this.store.upsertTools(name, tools);
      } catch (err) {
        logger.error(`Failed to refresh tools for "${name}": ${err}`);
      }
    }
  }

  // ── Lifecycle ─────────────────────────────────────────

  async startup(): Promise<void> {
    // Migration: if registry is empty but SQLite has servers, export to registry
    const registryEntries = this.registry.listEntries();
    const storeServers = this.store.listServers();

    if (registryEntries.length === 0 && storeServers.length > 0) {
      logger.info("Migrating servers from SQLite to servers.json");
      const toImport: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};
      for (const s of storeServers) {
        toImport[s.name] = { command: s.command, args: s.args, env: s.env };
      }
      this.registry.importServers(toImport);
    }

    // Read from registry (source of truth)
    const entries = this.registry.listEntries();
    const registryNames = new Set(entries.map((e) => e.name));

    // Sync to SQLite: upsert all from registry, remove stale entries
    for (const { name, entry } of entries) {
      this.store.upsertServer({
        name,
        command: entry.command,
        args: entry.args ?? [],
        env: entry.env,
      });
    }

    // Remove servers from SQLite that are no longer in registry
    for (const s of storeServers) {
      if (!registryNames.has(s.name)) {
        this.store.removeServer(s.name);
      }
    }

    // Harvest tools only if not already indexed
    for (const { name, entry } of entries) {
      if (this.store.getToolCount(name) === 0) {
        try {
          const tools = await harvestTools(entry.command, entry.args, entry.env);
          this.store.upsertTools(name, tools);
        } catch (err) {
          logger.error(`Failed to harvest tools for "${name}" during startup: ${err}`);
        }
      }
    }

    // Connect pool to all servers
    const allServers = this.store.listServers();
    logger.info(`Starting pool with ${allServers.length} servers`);
    await this.pool.connectAll(allServers);
  }

  async shutdown(): Promise<void> {
    await this.pool.closeAll();
    this.store.close();
  }
}
