import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { readdirSync } from "node:fs";
import { logger } from "./logger.js";
import { backupsDir } from "./config.js";

export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export function readConfig(configPath: string): McpConfig {
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as McpConfig;
}

export function backupConfig(configPath: string): string {
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true });
  const filename = configPath.replace(/[/\\]/g, "_");
  const backupPath = join(dir, `${filename}.${Date.now()}.bak`);
  copyFileSync(configPath, backupPath);

  // Verify backup
  const origSize = statSync(configPath).size;
  const backupSize = statSync(backupPath).size;
  if (backupSize !== origSize || backupSize === 0) {
    throw new Error(`Backup verification failed: original=${origSize}, backup=${backupSize}`);
  }

  logger.info(`Backed up ${configPath} → ${backupPath}`);
  return backupPath;
}

export function buildBrokerEntry(): McpServerEntry {
  const brokerHome = process.env.MCP_BROKER_HOME;
  if (brokerHome) {
    return {
      command: "node",
      args: [resolve("dist/index.js"), "serve"],
      env: { MCP_BROKER_HOME: resolve(brokerHome) },
    };
  }
  return { command: "npx", args: ["-y", "mcp-broker", "serve"] };
}

export function rewriteConfigForBroker(configPath: string): void {
  // Read existing config to preserve non-mcpServers keys
  let existing: McpConfig = {};
  try {
    existing = readConfig(configPath);
  } catch {
    // File might not exist yet
  }

  const newConfig: McpConfig = {
    ...existing,
    mcpServers: {
      "mcp-broker": buildBrokerEntry(),
    },
  };

  writeFileSync(configPath, JSON.stringify(newConfig, null, 2) + "\n", "utf-8");
  logger.info(`Rewrote ${configPath} to use mcp-broker`);
}

export function listBackups(): string[] {
  const dir = backupsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".bak"))
    .map((f) => join(dir, f))
    .sort();
}

export function restoreConfig(backupPath: string, targetPath: string): void {
  if (!existsSync(backupPath)) {
    throw new Error(`Backup not found: ${backupPath}`);
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(backupPath, targetPath);
  logger.info(`Restored ${backupPath} → ${targetPath}`);
}

export interface DetectedConfig {
  path: string;
  clientName: string;
}

interface KnownConfig {
  clientName: string;
  getPath: () => string;
}

function getKnownConfigs(): KnownConfig[] {
  const home = homedir();
  const os = platform();

  const configs: KnownConfig[] = [
    {
      clientName: "Claude Desktop",
      getPath: () => {
        if (os === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
        if (os === "linux") return join(home, ".config", "Claude", "claude_desktop_config.json");
        // Windows
        return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
      },
    },
    {
      clientName: "Cursor",
      getPath: () => join(home, ".cursor", "mcp.json"),
    },
    {
      clientName: "Windsurf",
      getPath: () => join(home, ".codeium", "windsurf", "mcp_config.json"),
    },
    {
      clientName: "Claude Code (project)",
      getPath: () => resolve(".mcp.json"),
    },
    {
      clientName: "Claude Code (user)",
      getPath: () => join(home, ".claude.json"),
    },
  ];

  return configs;
}

export function listKnownConfigPaths(): Array<{ clientName: string; path: string }> {
  return getKnownConfigs()
    .filter((c) => c.clientName !== "Claude Code (project)")
    .map((c) => ({ clientName: c.clientName, path: c.getPath() }));
}

export function hasBrokerEntry(configPath: string): boolean {
  if (!existsSync(configPath)) return false;
  try {
    const config = readConfig(configPath);
    return "mcp-broker" in (config.mcpServers ?? {});
  } catch {
    return false;
  }
}

export function addBrokerToConfig(configPath: string): void {
  let existing: McpConfig = {};
  try {
    existing = readConfig(configPath);
  } catch {
    // File might not exist yet — start fresh
  }

  const servers = existing.mcpServers ?? {};
  if ("mcp-broker" in servers) return; // Already present

  const newConfig: McpConfig = {
    ...existing,
    mcpServers: {
      ...servers,
      "mcp-broker": buildBrokerEntry(),
    },
  };

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(newConfig, null, 2) + "\n", "utf-8");
  logger.info(`Added mcp-broker to ${configPath}`);
}

export function detectConfigFiles(): DetectedConfig[] {
  const results: DetectedConfig[] = [];

  for (const cfg of getKnownConfigs()) {
    const p = cfg.getPath();
    if (!existsSync(p)) continue;

    try {
      const config = readConfig(p);
      const servers = config.mcpServers ?? {};
      const names = Object.keys(servers).filter((n) => n !== "mcp-broker");
      if (names.length === 0) continue;

      results.push({ path: p, clientName: cfg.clientName });
    } catch {
      // Unparseable file — skip
    }
  }

  return results;
}
