import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { registryPath, FILE_PERMISSION } from "./config.js";
import type { McpServerEntry } from "./client-config.js";

export interface RegistryData {
  mcpServers: Record<string, McpServerEntry>;
}

export class Registry {
  private filePath: string;
  private cache: RegistryData | null = null;

  constructor(filePath?: string) {
    this.filePath = filePath ?? registryPath();
  }

  read(): RegistryData {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      return { mcpServers: {} };
    }
    const raw = readFileSync(this.filePath, "utf-8");
    this.cache = JSON.parse(raw) as RegistryData;
    return this.cache;
  }

  addServer(name: string, entry: McpServerEntry): void {
    const data = this.read();
    data.mcpServers[name] = entry;
    this.write(data);
  }

  removeServer(name: string): void {
    const data = this.read();
    delete data.mcpServers[name];
    this.write(data);
  }

  getEntry(name: string): McpServerEntry | undefined {
    const data = this.read();
    return data.mcpServers[name];
  }

  listEntries(): Array<{ name: string; entry: McpServerEntry }> {
    const data = this.read();
    return Object.entries(data.mcpServers).map(([name, entry]) => ({ name, entry }));
  }

  importServers(servers: Record<string, McpServerEntry>): void {
    const data = this.read();
    Object.assign(data.mcpServers, servers);
    this.write(data);
  }

  private write(data: RegistryData): void {
    this.cache = data;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    try {
      chmodSync(this.filePath, FILE_PERMISSION);
    } catch {
      // May fail on some platforms; non-fatal
    }
  }
}
