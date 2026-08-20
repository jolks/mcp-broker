/**
 * Shared setup for the e2e suites (e2e-claude.test.ts, e2e-gemini.test.ts).
 * Kept separate from helpers.ts, which holds unit-test mocks.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Copy process.env to a plain string map, optionally excluding keys by prefix. */
export function copyEnv(excludePrefix?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (excludePrefix && k.startsWith(excludePrefix)) continue;
    env[k] = v;
  }
  return env;
}

/** Build the broker CLI so tests can spawn dist/index.js. */
export function buildBroker(root: string): void {
  execFileSync("pnpm", ["run", "build"], { cwd: root, timeout: 60_000, stdio: "pipe" });
}

// ── MCP config entries ─────────────────────────────────────
// The launch contracts live here once; suites compose entries into configs.

/** MCP config entry that launches this repo's broker against brokerHome. */
export function brokerEntry(root: string, brokerHome: string): object {
  return {
    command: "node",
    args: [resolve(root, "dist/index.js"), "serve"],
    env: { MCP_BROKER_HOME: brokerHome },
  };
}

/** MCP config entry for the echo fixture server. */
export function echoEntry(root: string): object {
  return { command: "npx", args: ["tsx", resolve(root, "tests/fixtures/echo-server.ts")] };
}

/** MCP config entry for the vibium browser server used in cost comparisons. */
export function vibiumEntry(): object {
  return { command: "npx", args: ["-y", "vibium", "mcp"] };
}

/** Write a standard MCP config file ({ mcpServers: {...} }). */
export function writeMcpConfig(configPath: string, mcpServers: Record<string, object>): void {
  writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2));
}

/** Seed the broker home (env.MCP_BROKER_HOME) with the servers in configPath. */
export function seedBroker(
  root: string,
  configPath: string,
  env: Record<string, string>,
  timeoutMs: number = 60_000,
): void {
  execFileSync(
    "node",
    ["dist/index.js", "setup", configPath, "--no-rewrite"],
    { cwd: root, timeout: timeoutMs, stdio: "pipe", env },
  );
}
