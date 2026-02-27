import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// tmpHome must be initialized before vi.mock runs at import time
let tmpHome: string = tmpdir();

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => tmpHome,
    platform: () => "darwin",
  };
});

// Import after mock is set up
const { detectConfigFiles } = await import("../src/client-config.js");

describe("detectConfigFiles", () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "mcp-broker-detect-"));
  });

  it("returns empty when no configs exist", () => {
    // May find .mcp.json in cwd (Claude Code project config), filter those out
    const results = detectConfigFiles().filter((r) => !r.clientName.startsWith("Claude Code"));
    expect(results).toEqual([]);
  });

  it("detects config that exists with mcpServers entries", () => {
    const cursorDir = join(tmpHome, ".cursor");
    const cursorPath = join(cursorDir, "mcp.json");
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      cursorPath,
      JSON.stringify({ mcpServers: { github: { command: "npx" } } })
    );

    const results = detectConfigFiles();
    expect(results.length).toBeGreaterThanOrEqual(1);
    const cursor = results.find((r) => r.clientName === "Cursor");
    expect(cursor).toBeDefined();
    expect(cursor!.path).toBe(cursorPath);
  });

  it("skips config with empty mcpServers", () => {
    const cursorDir = join(tmpHome, ".cursor");
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));

    const results = detectConfigFiles();
    const cursor = results.find((r) => r.clientName === "Cursor");
    expect(cursor).toBeUndefined();
  });

  it("skips config with only mcp-broker entry", () => {
    const cursorDir = join(tmpHome, ".cursor");
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      join(cursorDir, "mcp.json"),
      JSON.stringify({ mcpServers: { "mcp-broker": { command: "npx" } } })
    );

    const results = detectConfigFiles();
    const cursor = results.find((r) => r.clientName === "Cursor");
    expect(cursor).toBeUndefined();
  });

  it("skips unparseable files", () => {
    const cursorDir = join(tmpHome, ".cursor");
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, "mcp.json"), "not valid json {{{");

    const results = detectConfigFiles();
    const cursor = results.find((r) => r.clientName === "Cursor");
    expect(cursor).toBeUndefined();
  });
});
