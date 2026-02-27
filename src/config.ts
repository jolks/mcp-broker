import { homedir } from "node:os";
import { join } from "node:path";

// ── Identity ────────────────────────────────────────────

export const VERSION = "0.1.0";
export const SERVER_NAME = "mcp-broker";
export const HARVESTER_NAME = "mcp-broker-harvester";

// ── Paths ───────────────────────────────────────────────

export function brokerHome(): string {
  return process.env.MCP_BROKER_HOME ?? join(homedir(), ".mcp-broker");
}

export function dbPath(): string {
  return join(brokerHome(), "broker.db");
}

export function registryPath(): string {
  return join(brokerHome(), "servers.json");
}

export function backupsDir(): string {
  return join(brokerHome(), "backups");
}

// ── Permissions ─────────────────────────────────────────

export const FILE_PERMISSION = 0o600;

// ── Timeouts ────────────────────────────────────────────

export const HARVEST_TIMEOUT_MS = 30_000;
export const CONNECT_TIMEOUT_MS = 30_000;
export const INITIAL_RECONNECT_DELAY_MS = 5_000;
export const MAX_RECONNECT_DELAY_MS = 300_000; // 5 minutes
export const MAX_RECONNECT_ATTEMPTS = 10;

// ── Search ──────────────────────────────────────────────

export const DEFAULT_SEARCH_LIMIT = 20;
export const TOOL_PREFIX_SEPARATOR = "__";

// ── Utilities ───────────────────────────────────────────

/**
 * Merge optional env vars with process.env.
 * Returns undefined when no extra env is needed (lets child_process inherit).
 */
export function buildEnv(
  env?: Record<string, string>
): Record<string, string> | undefined {
  if (!env) return undefined;
  return { ...(process.env as Record<string, string>), ...env };
}

/**
 * Race a promise against a timeout. Clears the timer when the primary
 * promise settles so we don't leak timers or cause unhandled rejections.
 */
export function raceTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() =>
    clearTimeout(timer)
  );
}
