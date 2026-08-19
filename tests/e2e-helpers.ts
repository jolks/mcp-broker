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

/** Write an MCP config file pointing at the echo fixture server. */
export function writeEchoConfig(root: string, configPath: string): void {
  const echoServerPath = resolve(root, "tests/fixtures/echo-server.ts");
  const config = {
    mcpServers: {
      echo: { command: "npx", args: ["tsx", echoServerPath] },
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
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
