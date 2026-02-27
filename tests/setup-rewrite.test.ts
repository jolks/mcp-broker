import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSelection, promptAndRewriteConfigs, type ConfigCandidate, type PromptIO } from "../src/setup-rewrite.js";

// ── parseSelection ──────────────────────────────────────

describe("parseSelection", () => {
  it("returns all indices for empty string", () => {
    expect(parseSelection("", 3)).toEqual(new Set([0, 1, 2]));
  });

  it("returns all indices for 'all'", () => {
    expect(parseSelection("all", 3)).toEqual(new Set([0, 1, 2]));
  });

  it("returns all indices for 'ALL' (case-insensitive)", () => {
    expect(parseSelection("ALL", 3)).toEqual(new Set([0, 1, 2]));
  });

  it("returns empty set for 'none'", () => {
    expect(parseSelection("none", 3)).toEqual(new Set());
  });

  it("parses comma-separated numbers", () => {
    expect(parseSelection("1,3", 3)).toEqual(new Set([0, 2]));
  });

  it("parses space-separated numbers", () => {
    expect(parseSelection("1 3", 3)).toEqual(new Set([0, 2]));
  });

  it("parses single number", () => {
    expect(parseSelection("2", 3)).toEqual(new Set([1]));
  });

  it("returns null for 0 (out of range)", () => {
    expect(parseSelection("0", 3)).toBeNull();
  });

  it("returns null for non-numeric input", () => {
    expect(parseSelection("abc", 3)).toBeNull();
  });

  it("returns null when a number exceeds max", () => {
    expect(parseSelection("1,99", 3)).toBeNull();
  });

  it("handles whitespace around input", () => {
    expect(parseSelection("  2  ", 3)).toEqual(new Set([1]));
  });

  it("handles mixed commas and spaces", () => {
    expect(parseSelection("1, 2, 3", 3)).toEqual(new Set([0, 1, 2]));
  });
});

// ── promptAndRewriteConfigs ─────────────────────────────

describe("promptAndRewriteConfigs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-broker-rewrite-test-"));
    process.env.MCP_BROKER_HOME = tmpDir;
  });

  function fakeIO(answer: string): PromptIO & { logs: string[] } {
    const logs: string[] = [];
    return {
      ask: vi.fn().mockResolvedValue(answer),
      log: (msg: string) => logs.push(msg),
      logs,
    };
  }

  function writeConfig(path: string, servers: Record<string, unknown> = {}) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ mcpServers: servers }));
  }

  it("rewrites all candidates when user selects default (empty)", async () => {
    const sourcePath = join(tmpDir, "source.json");
    const crossPath = join(tmpDir, "cross.json");
    writeConfig(sourcePath, { github: { command: "npx", args: ["@mcp/github"] } });
    writeConfig(crossPath, { slack: { command: "npx", args: ["@mcp/slack"] } });

    const candidates: ConfigCandidate[] = [
      { clientName: "Claude Desktop", path: sourcePath, isSource: true },
      { clientName: "Cursor", path: crossPath, isSource: false },
    ];

    const io = fakeIO("");
    const result = await promptAndRewriteConfigs(candidates, io);

    expect(result.configured).toEqual(["Claude Desktop", "Cursor"]);
    expect(result.errors).toEqual([]);

    // Source should be rewritten (only mcp-broker)
    const sourceConfig = JSON.parse(readFileSync(sourcePath, "utf-8"));
    expect(Object.keys(sourceConfig.mcpServers)).toEqual(["mcp-broker"]);

    // Cross-client should have mcp-broker added (preserving existing)
    const crossConfig = JSON.parse(readFileSync(crossPath, "utf-8"));
    expect(crossConfig.mcpServers["mcp-broker"]).toBeDefined();
    expect(crossConfig.mcpServers.slack).toBeDefined();
  });

  it("skips all candidates when user selects 'none'", async () => {
    const sourcePath = join(tmpDir, "source.json");
    const crossPath = join(tmpDir, "cross.json");
    writeConfig(sourcePath, { github: { command: "npx" } });
    writeConfig(crossPath, {});

    const candidates: ConfigCandidate[] = [
      { clientName: "Claude Desktop", path: sourcePath, isSource: true },
      { clientName: "Cursor", path: crossPath, isSource: false },
    ];

    const io = fakeIO("none");
    const result = await promptAndRewriteConfigs(candidates, io);

    expect(result.configured).toEqual([]);

    // Source should NOT be rewritten
    const sourceConfig = JSON.parse(readFileSync(sourcePath, "utf-8"));
    expect(sourceConfig.mcpServers.github).toBeDefined();
    expect(sourceConfig.mcpServers["mcp-broker"]).toBeUndefined();
  });

  it("rewrites only selected candidates", async () => {
    const sourcePath = join(tmpDir, "source.json");
    const crossPath1 = join(tmpDir, "cross1.json");
    const crossPath2 = join(tmpDir, "cross2.json");
    writeConfig(sourcePath, { github: { command: "npx" } });
    writeConfig(crossPath1, {});
    writeConfig(crossPath2, {});

    const candidates: ConfigCandidate[] = [
      { clientName: "Claude Desktop", path: sourcePath, isSource: true },
      { clientName: "Cursor", path: crossPath1, isSource: false },
      { clientName: "Windsurf", path: crossPath2, isSource: false },
    ];

    const io = fakeIO("1,3");
    const result = await promptAndRewriteConfigs(candidates, io);

    expect(result.configured).toEqual(["Claude Desktop", "Windsurf"]);

    // Source rewritten
    const sourceConfig = JSON.parse(readFileSync(sourcePath, "utf-8"));
    expect(Object.keys(sourceConfig.mcpServers)).toEqual(["mcp-broker"]);

    // Cursor untouched
    const cross1Config = JSON.parse(readFileSync(crossPath1, "utf-8"));
    expect(cross1Config.mcpServers["mcp-broker"]).toBeUndefined();

    // Windsurf configured
    const cross2Config = JSON.parse(readFileSync(crossPath2, "utf-8"));
    expect(cross2Config.mcpServers["mcp-broker"]).toBeDefined();
  });

  it("calls backupConfig before rewriting source config", async () => {
    const sourcePath = join(tmpDir, "source.json");
    writeConfig(sourcePath, { github: { command: "npx" } });

    const candidates: ConfigCandidate[] = [
      { clientName: "Claude Desktop", path: sourcePath, isSource: true },
    ];

    const io = fakeIO("");
    await promptAndRewriteConfigs(candidates, io);

    // Backup directory should contain a backup file
    const backupsPath = join(tmpDir, "backups");
    const { readdirSync } = await import("node:fs");
    const backups = readdirSync(backupsPath).filter((f) => f.endsWith(".bak"));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty results for empty candidates", async () => {
    const io = fakeIO("");
    const result = await promptAndRewriteConfigs([], io);

    expect(result.configured).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(io.ask).not.toHaveBeenCalled();
  });

  it("displays the pick list with source label", async () => {
    const sourcePath = join(tmpDir, "source.json");
    const crossPath = join(tmpDir, "cross.json");
    writeConfig(sourcePath, { github: { command: "npx" } });
    writeConfig(crossPath, {});

    const candidates: ConfigCandidate[] = [
      { clientName: "Claude Desktop", path: sourcePath, isSource: true },
      { clientName: "Cursor", path: crossPath, isSource: false },
    ];

    const io = fakeIO("none");
    await promptAndRewriteConfigs(candidates, io);

    const listOutput = io.logs.join("\n");
    expect(listOutput).toContain("1. Claude Desktop");
    expect(listOutput).toContain("(source, will be rewritten)");
    expect(listOutput).toContain("2. Cursor");
  });

  it("retries on invalid input", async () => {
    const crossPath = join(tmpDir, "cross.json");
    writeConfig(crossPath, {});

    const candidates: ConfigCandidate[] = [
      { clientName: "Cursor", path: crossPath, isSource: false },
    ];

    const io: PromptIO & { logs: string[] } = {
      ask: vi.fn()
        .mockResolvedValueOnce("abc")  // invalid
        .mockResolvedValueOnce("1"),   // valid
      log: vi.fn(),
      logs: [],
    };

    const result = await promptAndRewriteConfigs(candidates, io);

    expect(io.ask).toHaveBeenCalledTimes(2);
    expect(result.configured).toEqual(["Cursor"]);
  });
});
