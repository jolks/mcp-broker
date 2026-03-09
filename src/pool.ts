import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ServerRecord } from "./store.js";
import { logger } from "./logger.js";
import { VERSION, SERVER_NAME, CONNECT_TIMEOUT_MS, INITIAL_RECONNECT_DELAY_MS, MAX_RECONNECT_DELAY_MS, MAX_RECONNECT_ATTEMPTS, buildEnv, raceTimeout } from "./config.js";

interface PoolEntry {
  client: Client;
  transport: StdioClientTransport;
}

export class Pool {
  private entries = new Map<string, PoolEntry>();
  private reconnectPending = new Set<string>();      // servers with a pending reconnect timer
  private reconnectAttempts = new Map<string, number>(); // server name → attempt count
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;

  async connectServer(server: ServerRecord): Promise<Client> {
    if (this.entries.has(server.name)) {
      return this.entries.get(server.name)!.client;
    }

    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: buildEnv(server.env),
      stderr: "pipe",
    });

    const client = new Client(
      { name: SERVER_NAME, version: VERSION },
    );

    // Listen for transport close to attempt reconnect
    transport.onclose = () => {
      if (this.closed) return;
      logger.warn(`Connection to "${server.name}" closed, will attempt reconnect`);
      this.entries.delete(server.name);
      this.scheduleReconnect(server);
    };

    transport.onerror = (err: Error) => {
      logger.error(`Transport error for "${server.name}": ${err.message}`);
    };

    await raceTimeout(
      client.connect(transport),
      CONNECT_TIMEOUT_MS,
      `Connection to "${server.name}" timed out`
    );

    this.entries.set(server.name, { client, transport });
    logger.info(`Connected to server "${server.name}"`);
    return client;
  }

  async connectAll(servers: ServerRecord[]): Promise<void> {
    const results = await Promise.allSettled(
      servers.map((s) => this.connectServer(s))
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        logger.error(
          `Failed to connect to "${servers[i].name}": ${(results[i] as PromiseRejectedResult).reason}`
        );
      }
    }
  }

  getClient(serverName: string): Client | undefined {
    return this.entries.get(serverName)?.client;
  }

  isConnected(serverName: string): boolean {
    return this.entries.has(serverName);
  }

  getServerVersion(name: string): { name: string; version: string } | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    return entry.client.getServerVersion();
  }

  async disconnectServer(name: string): Promise<void> {
    // Cancel any pending reconnect (even if entry already removed by onclose)
    this.reconnectPending.delete(name);
    this.reconnectAttempts.delete(name);
    const timer = this.reconnectTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(name);
    }

    const entry = this.entries.get(name);
    if (!entry) return;
    this.entries.delete(name);
    try {
      await entry.client.close();
    } catch {
      // Best-effort
    }
    try {
      await entry.transport.close();
    } catch {
      // Best-effort
    }
    logger.info(`Disconnected server "${name}"`);
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    const names = Array.from(this.entries.keys());
    await Promise.allSettled(names.map((n) => this.disconnectServer(n)));
  }

  private scheduleReconnect(server: ServerRecord): void {
    if (this.closed || this.reconnectPending.has(server.name)) return;

    const attempt = (this.reconnectAttempts.get(server.name) ?? 0) + 1;
    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      logger.error(
        `Giving up reconnecting to "${server.name}" after ${MAX_RECONNECT_ATTEMPTS} attempts`
      );
      this.reconnectAttempts.delete(server.name);
      return;
    }

    this.reconnectAttempts.set(server.name, attempt);
    this.reconnectPending.add(server.name);
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * 2 ** (attempt - 1),
      MAX_RECONNECT_DELAY_MS
    );

    const timer = setTimeout(async () => {
      this.reconnectPending.delete(server.name);
      this.reconnectTimers.delete(server.name);
      if (this.closed || this.entries.has(server.name)) return;
      try {
        await this.connectServer(server);
        this.reconnectAttempts.delete(server.name);
        logger.info(`Reconnected to "${server.name}"`);
      } catch (err) {
        logger.error(`Reconnect to "${server.name}" failed (attempt ${attempt}): ${err}`);
        this.scheduleReconnect(server);
      }
    }, delay);
    this.reconnectTimers.set(server.name, timer);
  }
}
