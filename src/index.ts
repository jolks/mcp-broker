#!/usr/bin/env node

import { Command } from "commander";
import { Store } from "./store.js";
import type { ServerRecord } from "./store.js";
import { Pool } from "./pool.js";
import { Broker } from "./broker.js";
import { Registry } from "./registry.js";
import { startServer } from "./server.js";
import { detectConfigFiles, listBackups, restoreConfig, readConfig, listKnownConfigPaths, hasBrokerEntry, isUrlEntry } from "./client-config.js";
import { setupFromConfig } from "./setup.js";
import { promptAndRewriteConfigs, type ConfigCandidate } from "./setup-rewrite.js";
import { harvestTools } from "./harvester.js";
import { existsSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { setLogLevel } from "./logger.js";
import { VERSION, SERVER_NAME } from "./config.js";

async function promptForConfigPath(rl: Interface): Promise<string> {
  const answer = await new Promise<string>((resolve) => {
    rl.question("Config path: ", resolve);
  });
  rl.close();

  const trimmed = answer.trim();
  if (!trimmed) {
    console.error("No path provided.");
    process.exit(1);
  }
  if (!existsSync(trimmed)) {
    console.error(`File not found: ${trimmed}`);
    process.exit(1);
  }
  return trimmed;
}

function countServers(path: string): number {
  try {
    const cfg = readConfig(path);
    return Object.keys(cfg.mcpServers ?? {}).filter((n) => n !== SERVER_NAME).length;
  } catch { return 0; }
}

const program = new Command();

program
  .name("mcp-broker")
  .description("One MCP server for all your tools — configure once, use everywhere")
  .version(VERSION);

// ── serve ──────────────────────────────────────────────

program
  .command("serve")
  .description("Start the mcp-broker MCP server (stdio)")
  .option("--debug", "Enable debug logging")
  .action(async (opts) => {
    if (opts.debug) setLogLevel("debug");

    const store = new Store();
    const pool = new Pool();
    const registry = new Registry();
    const broker = new Broker(store, pool, registry);

    await broker.startup();
    await startServer(broker);
  });

// ── setup ──────────────────────────────────────────────

program
  .command("setup [config-path]")
  .description("Auto-detect config, import servers, health-check, rewrite config, and configure other AI tools")
  .option("--no-rewrite", "Don't rewrite the config file or configure other AI tools")
  .option("--debug", "Enable debug logging")
  .action(async (configPath: string | undefined, opts) => {
    if (opts.debug) setLogLevel("debug");

    let resolvedPath: string;
    let selectedClientName: string | undefined;

    if (configPath) {
      resolvedPath = configPath;
    } else {
      const detected = detectConfigFiles();

      if (detected.length === 0) {
        console.log("No MCP config files found. Searched:");
        console.log("  - Claude Desktop (macOS/Linux/Windows)");
        console.log("  - Cursor (~/.cursor/mcp.json)");
        console.log("  - Windsurf (~/.codeium/windsurf/mcp_config.json)");
        console.log("  - Claude Code (.mcp.json, ~/.claude.json)");

        const rl = createInterface({ input: process.stdin, output: process.stdout });
        resolvedPath = await promptForConfigPath(rl);
      } else if (detected.length === 1) {
        resolvedPath = detected[0].path;
        selectedClientName = detected[0].clientName;

        const serverCount = countServers(resolvedPath);
        console.log(`Found config: ${detected[0].clientName} — ${detected[0].path} (${serverCount} server${serverCount !== 1 ? "s" : ""})\n`);
      } else {
        console.log("Which config should become your centralized server registry?\n");
        for (let i = 0; i < detected.length; i++) {
          const sc = countServers(detected[i].path);
          console.log(`  ${i + 1}. ${detected[i].clientName} — ${detected[i].path} (${sc} server${sc !== 1 ? "s" : ""})`);
        }
        const customOptionNum = detected.length + 1;
        console.log(`  ${customOptionNum}. Enter custom path`);

        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(`\nSelect [1-${customOptionNum}]: `, resolve);
        });

        const idx = parseInt(answer, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx > detected.length) {
          rl.close();
          console.error("Invalid selection.");
          process.exit(1);
        }

        if (idx === detected.length) {
          resolvedPath = await promptForConfigPath(rl);
        } else {
          rl.close();
          resolvedPath = detected[idx].path;
          selectedClientName = detected[idx].clientName;
        }
      }
    }

    const registry = new Registry();
    const store = new Store();
    try {
      const doRewrite = opts.rewrite !== false;
      const result = await setupFromConfig(registry, store, resolvedPath, { rewrite: false });

      if (result.servers.length === 0) {
        console.log("No servers found in config.");
        return;
      }

      // Health table
      const nameWidth = Math.max(6, ...result.servers.map((s) => s.name.length));
      console.log(`${"Server".padEnd(nameWidth)}  ${"Status".padEnd(8)}  Tools`);
      console.log("─".repeat(nameWidth + 18));
      for (const s of result.servers) {
        const status = s.healthy ? "OK" : "FAILED";
        console.log(`${s.name.padEnd(nameWidth)}  ${status.padEnd(8)}  ${s.toolCount}`);
      }

      // Warnings for unhealthy servers
      const unhealthy = result.servers.filter((s) => !s.healthy);
      if (unhealthy.length > 0) {
        console.log("\nWarnings:");
        for (const s of unhealthy) {
          console.log(`  ${s.name}: ${s.error}`);
        }
      }

      // Summary
      const healthy = result.servers.filter((s) => s.healthy).length;
      console.log(`\n${result.servers.length} server(s) imported (${healthy} healthy, ${unhealthy.length} unhealthy)`);
      if (result.backupPath) console.log(`Backup: ${result.backupPath}`);

      // ── Config rewrite: unified pick list ────────────
      if (doRewrite) {
        const { dirname } = await import("node:path");

        // Build unified candidate list: source config + cross-client configs
        const candidates: ConfigCandidate[] = [];

        // Source config (if it doesn't already have broker entry)
        if (!hasBrokerEntry(resolvedPath)) {
          candidates.push({
            clientName: selectedClientName ?? "Source config",
            path: resolvedPath,
            isSource: true,
          });
        }

        // Cross-client configs
        const known = listKnownConfigPaths();
        for (const k of known) {
          if (k.path === resolvedPath) continue;
          if (!existsSync(k.path) && !existsSync(dirname(k.path))) continue;
          if (hasBrokerEntry(k.path)) continue;
          candidates.push({ clientName: k.clientName, path: k.path, isSource: false });
        }

        if (candidates.length > 0) {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const io = {
            ask: (question: string) => new Promise<string>((resolve) => rl.question(question, resolve)),
            log: (message: string) => console.log(message),
          };

          const rewriteResult = await promptAndRewriteConfigs(candidates, io);
          rl.close();

          // Print results
          if (rewriteResult.configured.length > 0 || rewriteResult.errors.length > 0) {
            console.log();
            for (const name of rewriteResult.configured) {
              console.log(`  ✓ ${name}`);
            }
            for (const { name, error } of rewriteResult.errors) {
              console.log(`  ✗ ${name}: ${error}`);
            }

            const total = rewriteResult.configured.length;
            console.log(`\nDone! ${total} AI tool${total !== 1 ? "s" : ""} now share ${result.servers.length} MCP server${result.servers.length !== 1 ? "s" : ""} via mcp-broker.`);
          }
        }
      }
    } finally {
      store.close();
    }
  });

// ── list ───────────────────────────────────────────────

program
  .command("list")
  .description("List all registered servers and their tool counts")
  .action(async () => {
    const registry = new Registry();
    const store = new Store();
    try {
      const entries = registry.listEntries();
      if (entries.length === 0) {
        console.log("No servers registered. Run `mcp-broker setup` to add servers.");
        return;
      }

      console.log(`\n${"Server".padEnd(25)} ${"Tools".padEnd(8)}`);
      console.log("─".repeat(35));
      for (const { name } of entries) {
        const count = store.getToolCount(name);
        console.log(`${name.padEnd(25)} ${String(count).padEnd(8)}`);
      }
      console.log();
    } finally {
      store.close();
    }
  });

// ── refresh ────────────────────────────────────────────

program
  .command("refresh [server-name]")
  .description("Re-harvest tools from one or all servers")
  .option("--debug", "Enable debug logging")
  .action(async (serverName: string | undefined, opts) => {
    if (opts.debug) setLogLevel("debug");

    const registry = new Registry();
    const store = new Store();
    try {
      const entries = registry.listEntries();
      const servers = serverName
        ? entries.filter((e) => e.name === serverName)
        : entries;

      if (servers.length === 0) {
        console.log(serverName ? `Server "${serverName}" not found.` : "No servers to refresh.");
        return;
      }

      for (const { name, entry } of servers) {
        console.log(`Refreshing "${name}"...`);
        try {
          const record: ServerRecord = isUrlEntry(entry)
            ? { name, url: entry.url, headers: entry.headers }
            : { name, command: entry.command, args: entry.args ?? [], env: entry.env };
          const tools = await harvestTools(record);
          store.upsertTools(name, tools);
          console.log(`  ${tools.length} tools`);
        } catch (err) {
          console.error(`  Failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    } finally {
      store.close();
    }
  });

// ── restore ────────────────────────────────────────────

program
  .command("restore <target-path>")
  .description("Restore a config file from backup")
  .option("--backup <path>", "Specific backup file to restore (default: most recent)")
  .action(async (targetPath: string, opts) => {
    let backupPath = opts.backup as string | undefined;

    if (!backupPath) {
      const backups = listBackups();
      if (backups.length === 0) {
        console.error("No backups found in ~/.mcp-broker/backups/");
        process.exit(1);
      }
      backupPath = backups[backups.length - 1]; // Most recent
    }

    restoreConfig(backupPath, targetPath);
    console.log(`Restored ${backupPath} → ${targetPath}`);
  });

program.parse();
