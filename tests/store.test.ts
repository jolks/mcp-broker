import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

    it("getToolsForServer returns tool summaries ordered by name", () => {
      store.upsertTools("srv", [
        { tool_name: "beta_tool", description: "Beta", input_schema: "{}" },
        { tool_name: "alpha_tool", description: "Alpha", input_schema: "{}" },
      ]);
      const tools = store.getToolsForServer("srv");
      expect(tools).toEqual([
        { tool_name: "alpha_tool", description: "Alpha" },
        { tool_name: "beta_tool", description: "Beta" },
      ]);
    });

    it("getToolsForServer returns empty array for server with no tools", () => {
      expect(store.getToolsForServer("srv")).toEqual([]);
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
      const results = store.searchTools("new");
      expect(results.length).toBe(1);
      expect(results[0].tool_name).toBe("new");
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
      const results = store.searchTools("big");
      expect(results.length).toBe(1);
      expect(results[0].input_schema).toEqual(JSON.parse(largeSchema));
    });
  });

  // ── FTS5 Search ──────────────────────────────────────

  describe("FTS5 search", () => {
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

    it("finds tools by keyword", () => {
      const results = store.searchTools("github");
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.server_name === "github" || r.description.toLowerCase().includes("github"))).toBe(true);
    });

    it("finds tools by description keywords", () => {
      const results = store.searchTools("file");
      expect(results.length).toBeGreaterThan(0);
      const toolNames = results.map((r) => r.tool_name);
      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("write_file");
    });

    it("porter stemming matches inflections", () => {
      // "creating" should match "create" via porter stemming
      const results = store.searchTools("creating");
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.tool_name === "create_issue")).toBe(true);
    });

    it("returns empty array for no matches", () => {
      const results = store.searchTools("nonexistent_xyz_tool");
      expect(results).toEqual([]);
    });

    it("respects limit parameter", () => {
      const results = store.searchTools("file", 1);
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it("includes input_schema as parsed object", () => {
      const results = store.searchTools("create_issue");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].input_schema).toEqual({ type: "object" });
    });

    it("results have rank field", () => {
      const results = store.searchTools("github");
      for (const r of results) {
        expect(typeof r.rank).toBe("number");
      }
    });

    it("returns empty array for empty query", () => {
      expect(store.searchTools("")).toEqual([]);
    });

    it("returns empty array for query with only special chars", () => {
      expect(store.searchTools("***")).toEqual([]);
    });
  });

  // ── FTS5 sanitization ────────────────────────────────

  describe("FTS5 sanitization", () => {
    beforeEach(() => {
      store.upsertServer(makeServer({ name: "srv" }));
      store.upsertTools("srv", [
        { tool_name: "test_tool", description: "A test tool", input_schema: "{}" },
      ]);
    });

    it("strips special characters from queries", () => {
      // Should not throw FTS5 syntax error
      const results = store.searchTools("test AND OR NOT");
      expect(Array.isArray(results)).toBe(true);
    });

    it("handles parentheses in queries", () => {
      expect(() => store.searchTools("test(foo)")).not.toThrow();
    });

    it("handles quotes in queries", () => {
      expect(() => store.searchTools('"test"')).not.toThrow();
    });

    it("handles asterisks in queries", () => {
      expect(() => store.searchTools("test*")).not.toThrow();
    });

    it("handles colons in queries", () => {
      expect(() => store.searchTools("tool:test")).not.toThrow();
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

    it("removeServer clears FTS entries", () => {
      store.upsertServer(makeServer({ name: "srv" }));
      store.upsertTools("srv", [
        { tool_name: "unique_tool", description: "A unique tool", input_schema: "{}" },
      ]);
      expect(store.searchTools("unique_tool").length).toBeGreaterThan(0);

      store.removeServer("srv");
      expect(store.searchTools("unique_tool")).toEqual([]);
    });

    it("removeServer does not affect other servers", () => {
      store.upsertServer(makeServer({ name: "a" }));
      store.upsertServer(makeServer({ name: "b" }));
      store.upsertTools("a", [{ tool_name: "ta", description: "Tool A", input_schema: "{}" }]);
      store.upsertTools("b", [{ tool_name: "tb", description: "Tool B", input_schema: "{}" }]);

      store.removeServer("a");
      expect(store.getToolCount("b")).toBe(1);
      const results = store.searchTools("tb");
      expect(results.length).toBe(1);
    });
  });
});
