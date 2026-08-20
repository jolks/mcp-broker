import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Store } from "../src/store.js";
import { makeServer, makeUrlServer } from "./helpers.js";

describe("Store", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  // ── Server CRUD ──────────────────────────────────────

  describe("server CRUD", () => {
    it("upserts and retrieves a server", () => {
      const server = makeServer();
      store.upsertServer(server);
      const got = store.getServer("test-server");
      expect(got).toEqual(server);
    });

    it("returns undefined for non-existent server", () => {
      expect(store.getServer("nope")).toBeUndefined();
    });

    it("lists servers ordered by name", () => {
      store.upsertServer(makeServer({ name: "beta" }));
      store.upsertServer(makeServer({ name: "alpha" }));
      const servers = store.listServers();
      expect(servers.map((s) => s.name)).toEqual(["alpha", "beta"]);
    });

    it("upsert overwrites existing server", () => {
      store.upsertServer(makeServer({ name: "s1", command: "old" }));
      store.upsertServer(makeServer({ name: "s1", command: "new" }));
      const got = store.getServer("s1");
      expect(got?.command).toBe("new");
    });

    it("removes a server", () => {
      store.upsertServer(makeServer({ name: "s1" }));
      store.removeServer("s1");
      expect(store.getServer("s1")).toBeUndefined();
    });

    it("serializes env correctly", () => {
      store.upsertServer(makeServer({ name: "s1", env: { TOKEN: "abc" } }));
      const got = store.getServer("s1");
      expect(got?.env).toEqual({ TOKEN: "abc" });
    });

    it("handles undefined env", () => {
      store.upsertServer(makeServer({ name: "s1", env: undefined }));
      const got = store.getServer("s1");
      expect(got?.env).toBeUndefined();
    });

    it("upserts and retrieves a URL server", () => {
      const server = makeUrlServer();
      store.upsertServer(server);
      const got = store.getServer("test-url-server");
      expect(got).toEqual(server);
    });

    it("URL server has no command field", () => {
      store.upsertServer(makeUrlServer());
      const got = store.getServer("test-url-server");
      expect(got).toBeDefined();
      expect("url" in got!).toBe(true);
      expect("command" in got!).toBe(false);
    });

    it("URL server stores headers", () => {
      store.upsertServer(makeUrlServer({ name: "h1", headers: { Authorization: "Bearer tok" } }));
      const got = store.getServer("h1");
      expect(got).toBeDefined();
      expect("url" in got! && got.headers).toEqual({ Authorization: "Bearer tok" });
    });

    it("URL server with no headers", () => {
      store.upsertServer(makeUrlServer({ name: "h2" }));
      const got = store.getServer("h2");
      expect(got).toBeDefined();
      expect("url" in got! && got.headers).toBeUndefined();
    });

    it("lists mixed stdio and URL servers", () => {
      store.upsertServer(makeServer({ name: "alpha" }));
      store.upsertServer(makeUrlServer({ name: "beta" }));
      const servers = store.listServers();
      expect(servers.map((s) => s.name)).toEqual(["alpha", "beta"]);
      expect("command" in servers[0]).toBe(true);
      expect("url" in servers[1]).toBe(true);
    });

    it("overwriting stdio server with URL server works", () => {
      store.upsertServer(makeServer({ name: "s1" }));
      store.upsertServer(makeUrlServer({ name: "s1", url: "http://new.example.com" }));
      const got = store.getServer("s1");
      expect("url" in got!).toBe(true);
      expect("command" in got!).toBe(false);
    });
  });

  // ── CHECK constraints ──────────────────────────────────

  describe("CHECK constraints", () => {
    it("rejects inserting a server with both command and url", () => {
      expect(() => {
        store.runInTransaction(() => {
          (store as any).db
            .prepare(
              `INSERT INTO servers (name, command, url) VALUES ('bad', 'node', 'https://example.com')`
            )
            .run();
        });
      }).toThrow();
    });

    it("rejects inserting a server with neither command nor url", () => {
      expect(() => {
        store.runInTransaction(() => {
          (store as any).db
            .prepare(
              `INSERT INTO servers (name, command, url) VALUES ('bad', NULL, NULL)`
            )
            .run();
        });
      }).toThrow();
    });
  });

  // ── Tool CRUD ────────────────────────────────────────

  describe("tool CRUD", () => {
    beforeEach(() => {
      store.upsertServer(makeServer({ name: "srv" }));
    });

    it("upserts tools and reports correct count", () => {
      store.upsertTools("srv", [
        { tool_name: "foo", description: "Foo tool", input_schema: '{"type":"object"}' },
        { tool_name: "bar", description: "Bar tool", input_schema: '{}' },
      ]);

      expect(store.getToolCount("srv")).toBe(2);
    });

    it("getToolCount returns correct count", () => {
      store.upsertTools("srv", [
        { tool_name: "a", description: "", input_schema: "{}" },
        { tool_name: "b", description: "", input_schema: "{}" },
        { tool_name: "c", description: "", input_schema: "{}" },
      ]);
      expect(store.getToolCount("srv")).toBe(3);
    });

    it("getToolCount returns 0 for server with no tools", () => {
      expect(store.getToolCount("srv")).toBe(0);
    });

    it("listAllTools with filter returns tools ordered by name", () => {
      store.upsertTools("srv", [
        { tool_name: "beta_tool", description: "Beta", input_schema: "{}" },
        { tool_name: "alpha_tool", description: "Alpha", input_schema: "{}" },
      ]);
      const tools = store.listAllTools(["srv"]);
      expect(tools).toEqual([
        { server_name: "srv", tool_name: "alpha_tool", description: "Alpha" },
        { server_name: "srv", tool_name: "beta_tool", description: "Beta" },
      ]);
    });

    it("listAllTools with filter returns empty array for server with no tools", () => {
      expect(store.listAllTools(["srv"])).toEqual([]);
    });

    it("getLastHarvestedAt returns timestamp for server with tools", () => {
      store.upsertTools("srv", [
        { tool_name: "t1", description: "T1", input_schema: "{}" },
      ]);
      const ts = store.getLastHarvestedAt("srv");
      expect(ts).toBeDefined();
      expect(typeof ts).toBe("string");
      // Should be a valid ISO-ish datetime
      expect(new Date(ts! + "Z").getTime()).not.toBeNaN();
    });

    it("getLastHarvestedAt returns undefined for server with no tools", () => {
      expect(store.getLastHarvestedAt("srv")).toBeUndefined();
    });

    it("re-upsert replaces old tools", () => {
      store.upsertTools("srv", [
        { tool_name: "old", description: "Old", input_schema: "{}" },
      ]);
      store.upsertTools("srv", [
        { tool_name: "new", description: "New", input_schema: "{}" },
      ]);
      expect(store.getToolCount("srv")).toBe(1);
      const tools = store.listAllTools(["srv"]);
      expect(tools.length).toBe(1);
      expect(tools[0].tool_name).toBe("new");
    });

    it("handles large schema JSON", () => {
      const largeSchema = JSON.stringify({
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => [`prop${i}`, { type: "string" }])
        ),
      });
      store.upsertTools("srv", [
        { tool_name: "big", description: "Big schema", input_schema: largeSchema },
      ]);
      const { found } = store.getToolDetails([{ server_name: "srv", tool_name: "big" }]);
      expect(found.length).toBe(1);
      expect(found[0].input_schema).toEqual(JSON.parse(largeSchema));
    });
  });

  // ── listAllTools ─────────────────────────────────────

  describe("listAllTools", () => {
    beforeEach(() => {
      store.upsertServer(makeServer({ name: "github" }));
      store.upsertServer(makeServer({ name: "filesystem" }));
      store.upsertTools("github", [
        { tool_name: "create_issue", description: "Create a GitHub issue", input_schema: '{"type":"object"}' },
        { tool_name: "list_repos", description: "List GitHub repositories", input_schema: '{}' },
      ]);
      store.upsertTools("filesystem", [
        { tool_name: "read_file", description: "Read a file from the filesystem", input_schema: '{}' },
        { tool_name: "write_file", description: "Write content to a file", input_schema: '{}' },
      ]);
    });

    it("returns all tools ordered by server then tool name", () => {
      const tools = store.listAllTools();
      expect(tools.map((t) => `${t.server_name}/${t.tool_name}`)).toEqual([
        "filesystem/read_file",
        "filesystem/write_file",
        "github/create_issue",
        "github/list_repos",
      ]);
    });

    it("filters by a single server", () => {
      const tools = store.listAllTools(["github"]);
      expect(tools.every((t) => t.server_name === "github")).toBe(true);
      expect(tools.length).toBe(2);
    });

    it("filters by multiple servers", () => {
      const tools = store.listAllTools(["github", "filesystem"]);
      expect(tools.length).toBe(4);
    });

    it("returns empty array for unknown server filter", () => {
      expect(store.listAllTools(["nope"])).toEqual([]);
    });

    it("returns descriptions but no schemas", () => {
      const tools = store.listAllTools();
      expect(tools[0].description).toBeTruthy();
      expect(tools[0]).not.toHaveProperty("input_schema");
    });
  });

  // ── getToolDetails ───────────────────────────────────

  describe("getToolDetails", () => {
    beforeEach(() => {
      store.upsertServer(makeServer({ name: "srv" }));
      store.upsertTools("srv", [
        { tool_name: "alpha", description: "Alpha tool", input_schema: '{"type":"object","properties":{"a":{"type":"string"}},"required":["a"]}' },
        { tool_name: "beta", description: "Beta tool", input_schema: '{"type":"object"}' },
      ]);
    });

    it("returns parsed input_schema", () => {
      const { found } = store.getToolDetails([{ server_name: "srv", tool_name: "alpha" }]);
      expect(found).toEqual([
        {
          server_name: "srv",
          tool_name: "alpha",
          description: "Alpha tool",
          input_schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        },
      ]);
    });

    it("preserves request order", () => {
      const { found } = store.getToolDetails([
        { server_name: "srv", tool_name: "beta" },
        { server_name: "srv", tool_name: "alpha" },
      ]);
      expect(found.map((d) => d.tool_name)).toEqual(["beta", "alpha"]);
    });

    it("reports missing refs", () => {
      const { found, missing } = store.getToolDetails([
        { server_name: "srv", tool_name: "alpha" },
        { server_name: "srv", tool_name: "nonexistent" },
        { server_name: "other", tool_name: "alpha" },
      ]);
      expect(found.map((d) => d.tool_name)).toEqual(["alpha"]);
      expect(missing).toEqual([
        { server_name: "srv", tool_name: "nonexistent" },
        { server_name: "other", tool_name: "alpha" },
      ]);
    });

    it("returns empty results for empty refs", () => {
      expect(store.getToolDetails([])).toEqual({ found: [], missing: [] });
    });

    it("does not match another server's tool when names contain __", () => {
      store.upsertServer(makeServer({ name: "foo" }));
      store.upsertTools("foo", [
        { tool_name: "bar__baz", description: "Ambiguous name", input_schema: "{}" },
      ]);

      // "foo__bar"/"baz" and "foo"/"bar__baz" are distinct pairs — the
      // legacy concatenated-id scheme conflated them
      const miss = store.getToolDetails([{ server_name: "foo__bar", tool_name: "baz" }]);
      expect(miss.found).toEqual([]);
      expect(miss.missing).toHaveLength(1);
      expect(store.getToolDetails([{ server_name: "foo", tool_name: "bar__baz" }]).found).toHaveLength(1);
    });

    it("stores concatenation-colliding pairs side by side", () => {
      // Both pairs concatenate to "foo__bar__baz" — under the legacy id
      // PRIMARY KEY the second insert would have violated UNIQUE
      store.upsertServer(makeServer({ name: "foo" }));
      store.upsertTools("foo", [{ tool_name: "bar__baz", description: "A", input_schema: "{}" }]);
      store.upsertServer(makeServer({ name: "foo__bar" }));
      store.upsertTools("foo__bar", [{ tool_name: "baz", description: "B", input_schema: "{}" }]);

      expect(store.getToolDetails([{ server_name: "foo", tool_name: "bar__baz" }]).found[0].description).toBe("A");
      expect(store.getToolDetails([{ server_name: "foo__bar", tool_name: "baz" }]).found[0].description).toBe("B");
    });
  });

  // ── Cascade deletes ──────────────────────────────────

  describe("cascade deletes", () => {
    it("removeServer deletes associated tools", () => {
      store.upsertServer(makeServer({ name: "srv" }));
      store.upsertTools("srv", [
        { tool_name: "t1", description: "Tool 1", input_schema: "{}" },
      ]);
      expect(store.getToolCount("srv")).toBe(1);

      store.removeServer("srv");
      expect(store.getToolCount("srv")).toBe(0);
    });

    it("removeServer removes tools from the listing", () => {
      store.upsertServer(makeServer({ name: "srv" }));
      store.upsertTools("srv", [
        { tool_name: "unique_tool", description: "A unique tool", input_schema: "{}" },
      ]);
      expect(store.listAllTools().length).toBe(1);

      store.removeServer("srv");
      expect(store.listAllTools()).toEqual([]);
    });

    it("removeServer does not affect other servers", () => {
      store.upsertServer(makeServer({ name: "a" }));
      store.upsertServer(makeServer({ name: "b" }));
      store.upsertTools("a", [{ tool_name: "ta", description: "Tool A", input_schema: "{}" }]);
      store.upsertTools("b", [{ tool_name: "tb", description: "Tool B", input_schema: "{}" }]);

      store.removeServer("a");
      expect(store.getToolCount("b")).toBe(1);
      expect(store.listAllTools().map((t) => t.tool_name)).toEqual(["tb"]);
    });
  });

  // ── DB migration ──────────────────────────────────────

  describe("migrateUrlColumns", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "mcp-broker-migration-test-"));
    });

    function createOldSchemaDb(dbPath: string): void {
      const db = new Database(dbPath);
      db.pragma("journal_mode = WAL");
      db.exec(`
        CREATE TABLE servers (
          name TEXT PRIMARY KEY,
          command TEXT NOT NULL,
          args TEXT NOT NULL DEFAULT '[]',
          env TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);
      db.exec(`
        CREATE TABLE tools (
          id TEXT PRIMARY KEY,
          server_name TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          input_schema TEXT NOT NULL DEFAULT '{}',
          harvested_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (server_name) REFERENCES servers(name) ON DELETE CASCADE
        );
      `);
      db.prepare("INSERT INTO servers (name, command, args) VALUES (?, ?, ?)").run(
        "legacy", "node", '["old-server.js"]'
      );
      db.close();
    }

    it("migrates old schema and preserves existing stdio data", () => {
      const dbPath = join(tmpDir, "migrate.db");
      createOldSchemaDb(dbPath);

      const newStore = new Store(dbPath);
      const server = newStore.getServer("legacy");
      expect(server).toBeDefined();
      expect("command" in server!).toBe(true);
      expect(server!.command).toBe("node");
      newStore.close();
    });

    it("is idempotent — already-migrated DB does not break", () => {
      const dbPath = join(tmpDir, "idempotent.db");
      createOldSchemaDb(dbPath);

      // First open triggers migration
      const store1 = new Store(dbPath);
      store1.close();

      // Second open should not throw
      const store2 = new Store(dbPath);
      const server = store2.getServer("legacy");
      expect(server).toBeDefined();
      store2.close();
    });

    it("can insert URL server after migration", () => {
      const dbPath = join(tmpDir, "url-after-migrate.db");
      createOldSchemaDb(dbPath);

      const newStore = new Store(dbPath);
      newStore.upsertServer(makeUrlServer({ name: "remote", url: "https://example.com/mcp" }));
      const got = newStore.getServer("remote");
      expect(got).toBeDefined();
      expect("url" in got!).toBe(true);
      newStore.close();
    });
  });

  describe("legacy FTS5 index migration", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "mcp-broker-fts-migration-test-"));
    });

    // Historical schema (2026-07): post-URL-migration servers table, tools
    // table still keyed by the concatenated id, FTS5 index still present.
    // Opening it exercises both the id→composite-PK migration and the FTS drop.
    function createDbWithFts(dbPath: string): void {
      const db = new Database(dbPath);
      db.pragma("journal_mode = WAL");
      db.exec(`
        CREATE TABLE servers (
          name TEXT PRIMARY KEY,
          command TEXT,
          args TEXT NOT NULL DEFAULT '[]',
          env TEXT,
          url TEXT,
          headers TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          CHECK (command IS NOT NULL OR url IS NOT NULL),
          CHECK (NOT (command IS NOT NULL AND url IS NOT NULL))
        );
        CREATE TABLE tools (
          id TEXT PRIMARY KEY,
          server_name TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          input_schema TEXT NOT NULL DEFAULT '{}',
          harvested_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (server_name) REFERENCES servers(name) ON DELETE CASCADE
        );
        CREATE VIRTUAL TABLE tools_fts USING fts5(
          id, tool_name, description, server_name,
          tokenize='porter unicode61'
        );
      `);
      db.prepare("INSERT INTO servers (name, command) VALUES (?, ?)").run("legacy", "node");
      db.prepare(
        "INSERT INTO tools (id, server_name, tool_name, description) VALUES (?, ?, ?, ?)"
      ).run("legacy__t1", "legacy", "t1", "Tool one");
      db.prepare(
        "INSERT INTO tools_fts (id, tool_name, description, server_name) VALUES (?, ?, ?, ?)"
      ).run("legacy__t1", "t1", "Tool one", "legacy");
      db.close();
    }

    it("drops tools_fts and its shadow tables, keeps tools data", () => {
      const dbPath = join(tmpDir, "fts.db");
      createDbWithFts(dbPath);

      const newStore = new Store(dbPath);
      const remaining = (newStore as any).db
        .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'tools_fts%'")
        .all() as Array<{ name: string }>;
      expect(remaining).toEqual([]);
      expect(newStore.listAllTools()).toEqual([
        { server_name: "legacy", tool_name: "t1", description: "Tool one" },
      ]);
      newStore.close();
    });

    it("is idempotent on DBs without tools_fts", () => {
      const dbPath = join(tmpDir, "no-fts.db");
      const store1 = new Store(dbPath);
      store1.close();
      const store2 = new Store(dbPath);
      expect(store2.listAllTools()).toEqual([]);
      store2.close();
    });
  });
});
