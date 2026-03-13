import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readConfig, backupConfig, rewriteConfigForBroker, restoreConfig, listKnownConfigPaths, addBrokerToConfig, hasBrokerEntry, buildBrokerEntry, isUrlEntry, entryToRecord, recordToEntry } from "../src/client-config.js";

describe("config", () => {
  let tmpDir: string;

  function expectedDevEntry() {
    return {
      command: "node",
      args: [resolve("dist/index.js"), "serve"],
      env: { MCP_BROKER_HOME: resolve(tmpDir) },
    };
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-broker-test-"));
    process.env.MCP_BROKER_HOME = tmpDir;
  });

  // ── readConfig ──────────────────────────────────────

  describe("readConfig", () => {
    it("reads and parses valid JSON config", () => {
      const configPath = join(tmpDir, "config.json");
      const config = {
        mcpServers: {
          github: { command: "npx", args: ["@mcp/github"] },
        },
        someOtherKey: "value",
      };
      writeFileSync(configPath, JSON.stringify(config));

      const result = readConfig(configPath);
      expect(result.mcpServers).toEqual(config.mcpServers);
      expect(result.someOtherKey).toBe("value");
    });

    it("preserves all keys from config", () => {
      const configPath = join(tmpDir, "config.json");
      const config = { mcpServers: {}, customField: 42, nested: { a: 1 } };
      writeFileSync(configPath, JSON.stringify(config));

      const result = readConfig(configPath);
      expect(result.customField).toBe(42);
      expect(result.nested).toEqual({ a: 1 });
    });

    it("throws on missing file", () => {
      expect(() => readConfig(join(tmpDir, "nope.json"))).toThrow();
    });

    it("throws on invalid JSON", () => {
      const configPath = join(tmpDir, "bad.json");
      writeFileSync(configPath, "not json {{{");
      expect(() => readConfig(configPath)).toThrow();
    });

    it("throws on empty file", () => {
      const configPath = join(tmpDir, "empty.json");
      writeFileSync(configPath, "");
      expect(() => readConfig(configPath)).toThrow();
    });
  });

  // ── backupConfig ────────────────────────────────────

  describe("backupConfig", () => {
    it("creates backup and returns path", () => {
      const configPath = join(tmpDir, "config.json");
      writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));

      const backupPath = backupConfig(configPath);
      expect(backupPath).toContain(".bak");

      const backupContent = readFileSync(backupPath, "utf-8");
      const originalContent = readFileSync(configPath, "utf-8");
      expect(backupContent).toBe(originalContent);
    });

    it("throws when backup size is 0", () => {
      const configPath = join(tmpDir, "empty.json");
      writeFileSync(configPath, "");
      // Empty file has size 0, so backup verification should fail
      expect(() => backupConfig(configPath)).toThrow(/Backup verification failed/);
    });
  });

  // ── rewriteConfigForBroker ──────────────────────────

  describe("rewriteConfigForBroker", () => {
    it("rewrites mcpServers to use mcp-broker", () => {
      const configPath = join(tmpDir, "config.json");
      writeFileSync(configPath, JSON.stringify({
        mcpServers: { github: { command: "npx", args: ["@mcp/github"] } },
      }));

      rewriteConfigForBroker(configPath);

      const result = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(result.mcpServers).toEqual({
        "mcp-broker": expectedDevEntry(),
      });
    });

    it("preserves other keys in config", () => {
      const configPath = join(tmpDir, "config.json");
      writeFileSync(configPath, JSON.stringify({
        mcpServers: { github: { command: "npx" } },
        customSetting: true,
      }));

      rewriteConfigForBroker(configPath);

      const result = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(result.customSetting).toBe(true);
    });

    it("handles non-existent file gracefully", () => {
      const configPath = join(tmpDir, "new.json");
      rewriteConfigForBroker(configPath);

      const result = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(result.mcpServers).toEqual({
        "mcp-broker": expectedDevEntry(),
      });
    });
  });

  // ── listKnownConfigPaths ──────────────────────────

  describe("listKnownConfigPaths", () => {
    it("returns known config paths without Claude Code (project)", () => {
      const paths = listKnownConfigPaths();
      const names = paths.map((p) => p.clientName);
      expect(names).toContain("Cursor");
      expect(names).toContain("Claude Desktop");
      expect(names).toContain("Windsurf");
      expect(names).toContain("Claude Code (user)");
      expect(names).not.toContain("Claude Code (project)");
    });

    it("returns objects with clientName and path", () => {
      const paths = listKnownConfigPaths();
      for (const p of paths) {
        expect(p.clientName).toBeTruthy();
        expect(p.path).toBeTruthy();
      }
    });
  });

  // ── hasBrokerEntry ───────────────────────────────

  describe("hasBrokerEntry", () => {
    it("returns true when mcp-broker is in mcpServers", () => {
      const configPath = join(tmpDir, "config.json");
      writeFileSync(configPath, JSON.stringify({
        mcpServers: { "mcp-broker": { command: "npx", args: ["-y", "mcp-broker", "serve"] } },
      }));
      expect(hasBrokerEntry(configPath)).toBe(true);
    });

    it("returns false when mcp-broker is not present", () => {
      const configPath = join(tmpDir, "config.json");
      writeFileSync(configPath, JSON.stringify({
        mcpServers: { github: { command: "npx", args: ["@mcp/github"] } },
      }));
      expect(hasBrokerEntry(configPath)).toBe(false);
    });

    it("returns false when file does not exist", () => {
      expect(hasBrokerEntry(join(tmpDir, "nope.json"))).toBe(false);
    });

    it("returns false on invalid JSON", () => {
      const configPath = join(tmpDir, "bad.json");
      writeFileSync(configPath, "not json");
      expect(hasBrokerEntry(configPath)).toBe(false);
    });
  });

  // ── addBrokerToConfig ────────────────────────────

  describe("addBrokerToConfig", () => {
    it("adds mcp-broker to existing config preserving other servers", () => {
      const configPath = join(tmpDir, "config.json");
      writeFileSync(configPath, JSON.stringify({
        mcpServers: { github: { command: "npx", args: ["@mcp/github"] } },
        customKey: "preserved",
      }));

      addBrokerToConfig(configPath);

      const result = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(result.mcpServers["mcp-broker"]).toEqual(expectedDevEntry());
      expect(result.mcpServers.github).toEqual({ command: "npx", args: ["@mcp/github"] });
      expect(result.customKey).toBe("preserved");
    });

    it("creates new file when config does not exist", () => {
      const configPath = join(tmpDir, "subdir", "new.json");

      addBrokerToConfig(configPath);

      const result = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(result.mcpServers).toEqual({
        "mcp-broker": expectedDevEntry(),
      });
    });

    it("is idempotent — does not duplicate if already present", () => {
      const configPath = join(tmpDir, "config.json");
      writeFileSync(configPath, JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["@mcp/github"] },
          "mcp-broker": { command: "npx", args: ["-y", "mcp-broker", "serve"] },
        },
      }));

      addBrokerToConfig(configPath);

      const result = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(Object.keys(result.mcpServers)).toHaveLength(2);
    });
  });

  // ── buildBrokerEntry ────────────────────────────────

  describe("buildBrokerEntry", () => {
    it("returns dev entry when MCP_BROKER_HOME is set", () => {
      process.env.MCP_BROKER_HOME = tmpDir;
      const entry = buildBrokerEntry();
      expect(entry.command).toBe("node");
      expect(entry.args).toEqual([resolve("dist/index.js"), "serve"]);
      expect(entry.env).toEqual({ MCP_BROKER_HOME: resolve(tmpDir) });
    });

    it("resolves relative MCP_BROKER_HOME to absolute path", () => {
      process.env.MCP_BROKER_HOME = "./.mcp-broker";
      const entry = buildBrokerEntry();
      expect(entry.env!.MCP_BROKER_HOME).toBe(resolve(".mcp-broker"));
      expect(entry.env!.MCP_BROKER_HOME).toMatch(/^\//);
    });

    it("returns production entry when MCP_BROKER_HOME is not set", () => {
      delete process.env.MCP_BROKER_HOME;
      const entry = buildBrokerEntry();
      expect(entry).toEqual({ command: "npx", args: ["-y", "mcp-broker", "serve"] });
    });
  });

  // ── isUrlEntry ────────────────────────────────────

  describe("isUrlEntry", () => {
    it("returns true for URL entries", () => {
      expect(isUrlEntry({ url: "https://example.com/mcp" })).toBe(true);
      expect(isUrlEntry({ url: "https://example.com/mcp", headers: { Auth: "Bearer tok" } })).toBe(true);
    });

    it("returns false for stdio entries", () => {
      expect(isUrlEntry({ command: "npx", args: ["@mcp/github"] })).toBe(false);
      expect(isUrlEntry({ command: "node" })).toBe(false);
    });
  });

  // ── restoreConfig ───────────────────────────────────

  describe("restoreConfig", () => {
    it("copies backup to target", () => {
      const backupPath = join(tmpDir, "backup.bak");
      const targetPath = join(tmpDir, "restored.json");
      const content = JSON.stringify({ mcpServers: { github: { command: "npx" } } });
      writeFileSync(backupPath, content);

      restoreConfig(backupPath, targetPath);

      expect(readFileSync(targetPath, "utf-8")).toBe(content);
    });

    it("creates target directory if needed", () => {
      const backupPath = join(tmpDir, "backup.bak");
      const targetPath = join(tmpDir, "subdir", "nested", "config.json");
      writeFileSync(backupPath, "{}");

      restoreConfig(backupPath, targetPath);
      expect(readFileSync(targetPath, "utf-8")).toBe("{}");
    });

    it("throws when backup does not exist", () => {
      expect(() =>
        restoreConfig(join(tmpDir, "nope.bak"), join(tmpDir, "target.json"))
      ).toThrow(/Backup not found/);
    });
  });

  // ── entryToRecord ─────────────────────────────────────

  describe("entryToRecord", () => {
    it("converts stdio entry to StdioServerRecord", () => {
      const record = entryToRecord("srv", { command: "npx", args: ["@mcp/github"], env: { TOKEN: "abc" } });
      expect(record).toEqual({ name: "srv", command: "npx", args: ["@mcp/github"], env: { TOKEN: "abc" } });
    });

    it("defaults args to empty array when missing", () => {
      const record = entryToRecord("srv", { command: "node" });
      expect(record).toEqual({ name: "srv", command: "node", args: [], env: undefined });
    });

    it("converts URL entry to UrlServerRecord", () => {
      const record = entryToRecord("srv", { url: "https://example.com/mcp", headers: { Authorization: "Bearer tok" } });
      expect(record).toEqual({ name: "srv", url: "https://example.com/mcp", headers: { Authorization: "Bearer tok" } });
    });

    it("converts URL entry without headers", () => {
      const record = entryToRecord("srv", { url: "https://example.com/mcp" });
      expect(record).toEqual({ name: "srv", url: "https://example.com/mcp", headers: undefined });
    });

    it("warns and prefers URL when entry has both url and command", async () => {
      const { logger } = await import("../src/logger.js");
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

      const entry = { url: "https://example.com/mcp", command: "npx", args: ["@mcp/github"] } as any;
      const record = entryToRecord("srv", entry);

      expect("url" in record).toBe(true);
      expect("command" in record).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("both url and command"));

      warnSpy.mockRestore();
    });
  });

  // ── recordToEntry ─────────────────────────────────────

  describe("recordToEntry", () => {
    it("converts StdioServerRecord to StdioServerEntry", () => {
      const entry = recordToEntry({ name: "srv", command: "npx", args: ["@mcp/github"], env: { TOKEN: "abc" } });
      expect(entry).toEqual({ command: "npx", args: ["@mcp/github"], env: { TOKEN: "abc" } });
    });

    it("converts UrlServerRecord to UrlServerEntry", () => {
      const entry = recordToEntry({ name: "srv", url: "https://example.com/mcp", headers: { Authorization: "Bearer tok" } });
      expect(entry).toEqual({ url: "https://example.com/mcp", headers: { Authorization: "Bearer tok" } });
    });

    it("round-trips stdio record through entry and back", () => {
      const original = { name: "srv", command: "node", args: ["server.js"], env: { KEY: "val" } };
      const entry = recordToEntry(original);
      const roundTripped = entryToRecord("srv", entry);
      expect(roundTripped).toEqual(original);
    });

    it("round-trips URL record through entry and back", () => {
      const original = { name: "srv", url: "https://example.com/mcp", headers: { Auth: "tok" } };
      const entry = recordToEntry(original);
      const roundTripped = entryToRecord("srv", entry);
      expect(roundTripped).toEqual(original);
    });
  });

});
