import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Store, type ServerRecord, type SearchResult, type ToolSummary } from "./store.js";
import { Pool } from "./pool.js";
import { Registry } from "./registry.js";
import { harvestTools } from "./harvester.js";
import { logger } from "./logger.js";
import { getErrorMessage, BACKGROUND_REFRESH_TTL_MS, DEFAULT_SEARCH_LIMIT } from "./config.js";
import type { McpServerEntry } from "./client-config.js";

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

export interface CallToolsOptions {
  sequential?: boolean;
}

export interface ServerDetail {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  connected: boolean;
  toolCount: number;
  tools: ToolSummary[];
  version?: string;
}

export class Broker {
  private store: Store;
  private pool: Pool;
  private registry: Registry;
  private backgroundRefreshPromise: Promise<void> | null = null;

  constructor(store: Store, pool: Pool, registry: Registry) {
    this.store = store;
    this.pool = pool;
    this.registry = registry;
  }

  // ── Search ─────────────────────────────────────────────

  searchTools(query: string, limit?: number): SearchResult[] {
    return this.store.searchTools(query, limit);
  }

  searchToolsMulti(queries: string[], limit?: number): SearchResult[] {
    const perQuery = limit ?? DEFAULT_SEARCH_LIMIT;
    const seen = new Map<string, SearchResult>();
    for (const query of queries) {
      for (const result of this.store.searchTools(query, perQuery)) {
        const existing = seen.get(result.id);
        if (!existing || result.rank < existing.rank) {
          seen.set(result.id, result); // keep best rank (BM25: lower = better)
        }
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.rank - b.rank);
  }

  // ── Call Tools ──────────────────────────────────────────

  async callTools(invocations: ToolInvocation[], options?: CallToolsOptions): Promise<CallToolResult> {
    if (options?.sequential) {
      return this.callToolsSequential(invocations);
    }

    const results = await Promise.allSettled(
      invocations.map((inv) => this.callTool(inv.server_name, inv.tool_name, inv.arguments ?? {}))
    );

    // Single invocation: pass through the downstream result as-is (zero overhead)
    if (invocations.length === 1) {
      const r = results[0];
      if (r.status === "fulfilled") return r.value;
      return { content: [{ type: "text", text: String(r.reason) }], isError: true };
    }

    // Multiple invocations: flatten content arrays with text headers
    const content: CallToolResult["content"] = [];
    let hasError = false;
    for (let i = 0; i < invocations.length; i++) {
      const inv = invocations[i];
      const r = results[i];
      content.push({ type: "text" as const, text: `[${inv.server_name}/${inv.tool_name}]` });
      if (r.status === "fulfilled") {
        content.push(...(r.value.content ?? []));
        if (r.value.isError) hasError = true;
      } else {
        content.push({ type: "text" as const, text: String(r.reason) });
        hasError = true;
      }
    }
    return { content, ...(hasError ? { isError: true } : {}) };
  }

  private async callToolsSequential(invocations: ToolInvocation[]): Promise<CallToolResult> {
    const content: CallToolResult["content"] = [];
    let hasError = false;
    for (const inv of invocations) {
      content.push({ type: "text" as const, text: `[${inv.server_name}/${inv.tool_name}]` });
      const result = await this.callTool(inv.server_name, inv.tool_name, inv.arguments ?? {});
      content.push(...(result.content ?? []));
      if (result.isError) { hasError = true; break; }
    }
    return { content, ...(hasError ? { isError: true } : {}) };
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
            text: `Server "${serverName}" is not connected. Wait for reconnect, or restart mcp-broker / your LLM client.`,
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
            text: `Error calling ${toolName}: ${getErrorMessage(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  // ── Server Management ─────────────────────────────────

  private toRegistryEntry(server: ServerRecord): McpServerEntry {
    return { command: server.command, args: server.args, env: server.env };
  }

  async addServer(server: ServerRecord): Promise<{ toolCount: number }> {
    // Write to registry first (source of truth)
    this.registry.addServer(server.name, this.toRegistryEntry(server));

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
      version: this.pool.getServerVersion(server.name)?.version,
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
    this.registry.addServer(name, this.toRegistryEntry(merged));
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

    // Sync to SQLite in a single transaction: upsert all from registry, remove stale entries
    this.store.runInTransaction(() => {
      for (const { name, entry } of entries) {
        this.store.upsertServer({
          name,
          command: entry.command,
          args: entry.args ?? [],
          env: entry.env,
        });
      }
      for (const s of storeServers) {
        if (!registryNames.has(s.name)) {
          this.store.removeServer(s.name);
        }
      }
    });

    // Harvest tools in parallel for servers not already indexed
    const toHarvest = entries.filter(({ name }) => this.store.getToolCount(name) === 0);
    const harvestResults = await Promise.allSettled(
      toHarvest.map(async ({ name, entry }) => {
        const tools = await harvestTools(entry.command, entry.args, entry.env);
        return { name, tools };
      })
    );
    for (const r of harvestResults) {
      if (r.status === "fulfilled") {
        this.store.upsertTools(r.value.name, r.value.tools);
      } else {
        logger.error(`Failed to harvest tools during startup: ${getErrorMessage(r.reason)}`);
      }
    }

    // Connect pool to all servers
    const allServers = this.store.listServers();
    logger.info(`Starting pool with ${allServers.length} servers`);
    await this.pool.connectAll(allServers);

    // Fire background refresh for stale servers (non-blocking)
    this.backgroundRefreshPromise = this.backgroundRefresh();
  }

  private async backgroundRefresh(): Promise<void> {
    const entries = this.registry.listEntries();
    const now = Date.now();

    const stale = entries.filter(({ name }) => {
      if (this.store.getToolCount(name) === 0) return false;
      const harvestedAt = this.store.getLastHarvestedAt(name);
      if (!harvestedAt) return true;
      const age = now - new Date(harvestedAt + "Z").getTime();
      return age > BACKGROUND_REFRESH_TTL_MS;
    });

    if (stale.length === 0) return;
    logger.info(`Background refresh: re-harvesting ${stale.length} stale server(s)`);

    const results = await Promise.allSettled(
      stale.map(async ({ name, entry }) => {
        const tools = await harvestTools(entry.command, entry.args, entry.env);
        return { name, tools };
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        this.store.upsertTools(r.value.name, r.value.tools);
        logger.info(`Background refresh: updated tools for "${r.value.name}"`);
      } else {
        logger.error(`Background refresh failed: ${getErrorMessage(r.reason)}`);
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.backgroundRefreshPromise) {
      await this.backgroundRefreshPromise;
    }
    await this.pool.closeAll();
    this.store.close();
  }
}
