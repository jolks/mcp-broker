import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Store, type ServerRecord, type ToolListing, type ToolRef, type ToolDetail, isUrlServer } from "./store.js";
import { Pool } from "./pool.js";
import { Registry } from "./registry.js";
import { harvestTools } from "./harvester.js";
import { logger } from "./logger.js";
import { getErrorMessage, BACKGROUND_REFRESH_TTL_MS } from "./config.js";
import { type McpServerEntry, entryToRecord, recordToEntry } from "./client-config.js";

export interface ToolInvocation {
  server_name: string;
  tool_name: string;
  arguments?: Record<string, unknown>;
}

export interface ServerUpdate {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface CallToolsOptions {
  sequential?: boolean;
}

export interface ServerSummary {
  name: string;
  connected: boolean;
  toolCount: number;
  source: string; // launch command for stdio servers, URL for URL servers
  envKeys: string[]; // env var names for stdio servers — values never exposed
  headerKeys: string[]; // header names for URL servers — values never exposed
}

// Args like ["--api-key", "sk-…"] would otherwise leak secrets into every
// list_mcp_servers response (a common pattern for servers that take tokens as flags).
const SENSITIVE_FLAG = /key|token|secret|password|passwd|auth|credential/i;

export function redactSensitiveArgs(args: string[]): string[] {
  const redacted: string[] = [];
  let maskNext = false;
  for (const arg of args) {
    if (maskNext) {
      redacted.push("***");
      maskNext = false;
    } else if (arg.startsWith("-") && SENSITIVE_FLAG.test(arg)) {
      const eq = arg.indexOf("=");
      if (eq === -1) {
        redacted.push(arg);
        maskNext = true;
      } else {
        redacted.push(arg.slice(0, eq + 1) + "***");
      }
    } else {
      redacted.push(arg);
    }
  }
  return redacted;
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

  // ── Discovery ──────────────────────────────────────────

  listTools(serverNames?: string[]): { tools: ToolListing[]; unknownServers: string[] } {
    const known = new Set(this.store.listServers().map((s) => s.name));
    const unknownServers = (serverNames ?? []).filter((n) => !known.has(n));
    return { tools: this.store.listAllTools(serverNames), unknownServers };
  }

  describeTools(refs: ToolRef[]): { found: ToolDetail[]; missing: ToolRef[] } {
    const found = this.store.getToolDetails(refs);
    // Key by (server, tool) pair — concatenated "server__tool" ids are ambiguous
    // when either name itself contains the separator
    const key = (r: ToolRef) => JSON.stringify([r.server_name, r.tool_name]);
    const foundKeys = new Set(found.map(key));
    const missing = refs.filter((r) => !foundKeys.has(key(r)));
    return { found, missing };
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

  async addServer(server: ServerRecord): Promise<{ toolCount: number }> {
    // Write to registry first (source of truth)
    this.registry.addServer(server.name, recordToEntry(server));

    this.store.upsertServer(server);

    const tools = await harvestTools(server);
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

  listServers(): ServerSummary[] {
    const servers = this.store.listServers();
    return servers.map((s) => ({
      name: s.name,
      connected: this.pool.isConnected(s.name),
      toolCount: this.store.getToolCount(s.name),
      // Env/header values and secret-looking args are deliberately excluded or
      // redacted (may contain API keys); key names are exposed so
      // update_mcp_server callers know which vars exist and must be preserved
      source: isUrlServer(s) ? s.url : [s.command, ...redactSensitiveArgs(s.args)].join(" "),
      envKeys: isUrlServer(s) ? [] : Object.keys(s.env ?? {}),
      headerKeys: isUrlServer(s) ? Object.keys(s.headers ?? {}) : [],
    }));
  }

  async updateServer(name: string, updates: ServerUpdate): Promise<{ toolCount: number }> {
    const existing = this.store.getServer(name);
    if (!existing) {
      throw new Error(`Server "${name}" not found`);
    }

    let merged: ServerRecord;
    if (updates.url !== undefined) {
      // Switching to or updating a URL-based server
      merged = { name, url: updates.url, headers: updates.headers };
    } else if (isUrlServer(existing) && updates.command === undefined) {
      // Existing URL server, updating headers only
      merged = { name, url: existing.url, headers: updates.headers ?? existing.headers };
    } else if (isUrlServer(existing)) {
      // Switching from URL to stdio
      merged = { name, command: updates.command!, args: updates.args ?? [], env: updates.env };
    } else {
      // Existing stdio server, partial update
      merged = {
        name,
        command: updates.command ?? existing.command,
        args: updates.args ?? existing.args,
        env: updates.env ?? existing.env,
      };
    }

    // Write to registry (source of truth) and store
    this.registry.addServer(name, recordToEntry(merged));
    this.store.upsertServer(merged);

    // Disconnect, re-harvest, reconnect
    await this.pool.disconnectServer(name);
    const tools = await harvestTools(merged);
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

    await this.harvestAndStoreAll(servers, "Refresh");
  }

  // ── Harvest helper ──────────────────────────────────────

  private async harvestAndStoreAll(
    servers: Array<{ name: string; entry: McpServerEntry }>,
    logPrefix?: string,
  ): Promise<void> {
    const results = await Promise.allSettled(
      servers.map(async ({ name, entry }) => {
        const tools = await harvestTools(entryToRecord(name, entry));
        return { name, tools };
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        this.store.upsertTools(r.value.name, r.value.tools);
        if (logPrefix) logger.info(`${logPrefix}: updated tools for "${r.value.name}"`);
      } else {
        logger.error(`${logPrefix ?? "Harvest"} failed: ${getErrorMessage(r.reason)}`);
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
      const toImport: Record<string, McpServerEntry> = {};
      for (const s of storeServers) {
        toImport[s.name] = recordToEntry(s);
      }
      this.registry.importServers(toImport);
    }

    // Read from registry (source of truth)
    const entries = this.registry.listEntries();
    const registryNames = new Set(entries.map((e) => e.name));

    // Sync to SQLite in a single transaction: upsert all from registry, remove stale entries
    this.store.runInTransaction(() => {
      for (const { name, entry } of entries) {
        this.store.upsertServer(entryToRecord(name, entry));
      }
      for (const s of storeServers) {
        if (!registryNames.has(s.name)) {
          this.store.removeServer(s.name);
        }
      }
    });

    // Harvest tools in parallel for servers not already indexed
    const toHarvest = entries.filter(({ name }) => this.store.getToolCount(name) === 0);
    await this.harvestAndStoreAll(toHarvest, "Startup");

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

    await this.harvestAndStoreAll(stale, "Background refresh");
  }

  async shutdown(): Promise<void> {
    if (this.backgroundRefreshPromise) {
      await this.backgroundRefreshPromise;
    }
    await this.pool.closeAll();
    this.store.close();
  }
}
