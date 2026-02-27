import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Registry } from "../src/registry.js";

describe("Registry", () => {
  let tmpDir: string;
  let registry: Registry;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-broker-registry-test-"));
    registry = new Registry(join(tmpDir, "servers.json"));
  });

  describe("read", () => {
    it("returns empty mcpServers when file missing", () => {
      const data = registry.read();
      expect(data).toEqual({ mcpServers: {} });
    });
  });

  describe("addServer", () => {
    it("creates file and writes entry", () => {
      registry.addServer("github", { command: "npx", args: ["@mcp/github"] });

      const data = registry.read();
      expect(data.mcpServers.github).toEqual({ command: "npx", args: ["@mcp/github"] });
    });

    it("preserves existing entries", () => {
      registry.addServer("github", { command: "npx", args: ["@mcp/github"] });
      registry.addServer("slack", { command: "npx", args: ["@mcp/slack"] });

      const data = registry.read();
      expect(Object.keys(data.mcpServers)).toEqual(["github", "slack"]);
    });

    it("overwrites existing entry with same name", () => {
      registry.addServer("github", { command: "npx", args: ["old"] });
      registry.addServer("github", { command: "npx", args: ["new"] });

      const data = registry.read();
      expect(data.mcpServers.github.args).toEqual(["new"]);
    });

    it("stores env vars", () => {
      registry.addServer("github", { command: "npx", args: [], env: { TOKEN: "abc" } });

      const data = registry.read();
      expect(data.mcpServers.github.env).toEqual({ TOKEN: "abc" });
    });
  });

  describe("removeServer", () => {
    it("removes entry", () => {
      registry.addServer("github", { command: "npx" });
      registry.addServer("slack", { command: "npx" });

      registry.removeServer("github");

      const data = registry.read();
      expect(Object.keys(data.mcpServers)).toEqual(["slack"]);
    });

    it("no-op for non-existent server", () => {
      registry.addServer("github", { command: "npx" });
      registry.removeServer("nonexistent");

      const data = registry.read();
      expect(Object.keys(data.mcpServers)).toEqual(["github"]);
    });
  });

  describe("getEntry", () => {
    it("returns entry for existing server", () => {
      registry.addServer("github", { command: "npx", args: ["@mcp/github"], env: { TOKEN: "abc" } });

      const entry = registry.getEntry("github");
      expect(entry).toEqual({ command: "npx", args: ["@mcp/github"], env: { TOKEN: "abc" } });
    });

    it("returns undefined for missing server", () => {
      expect(registry.getEntry("nonexistent")).toBeUndefined();
    });
  });

  describe("listEntries", () => {
    it("returns empty array when no servers", () => {
      expect(registry.listEntries()).toEqual([]);
    });

    it("returns all entries", () => {
      registry.addServer("github", { command: "npx", args: ["@mcp/github"] });
      registry.addServer("slack", { command: "npx", args: ["@mcp/slack"] });

      const entries = registry.listEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].name).toBe("github");
      expect(entries[1].name).toBe("slack");
    });
  });

  describe("importServers", () => {
    it("merges entries", () => {
      registry.addServer("github", { command: "npx", args: ["@mcp/github"] });

      registry.importServers({
        slack: { command: "npx", args: ["@mcp/slack"] },
        filesystem: { command: "npx", args: ["@mcp/fs"] },
      });

      const data = registry.read();
      expect(Object.keys(data.mcpServers).sort()).toEqual(["filesystem", "github", "slack"]);
    });

    it("overwrites existing entries on conflict", () => {
      registry.addServer("github", { command: "npx", args: ["old"] });

      registry.importServers({
        github: { command: "npx", args: ["new"] },
      });

      const data = registry.read();
      expect(data.mcpServers.github.args).toEqual(["new"]);
    });
  });

  describe("file format", () => {
    it("writes pretty-printed JSON with trailing newline", () => {
      registry.addServer("test", { command: "echo" });

      const raw = readFileSync(join(tmpDir, "servers.json"), "utf-8");
      expect(raw).toContain("\n");
      expect(raw.endsWith("\n")).toBe(true);
      // Should be parseable
      const parsed = JSON.parse(raw);
      expect(parsed.mcpServers.test.command).toBe("echo");
    });
  });
});
