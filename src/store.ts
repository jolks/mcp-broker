import Database from "better-sqlite3";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "./logger.js";
import { dbPath as defaultDbPath, FILE_PERMISSION, TOOL_PREFIX_SEPARATOR, DEFAULT_SEARCH_LIMIT } from "./config.js";

/** Build prefixed tool name: "server__tool" */
function prefixToolName(serverName: string, toolName: string): string {
  return `${serverName}${TOOL_PREFIX_SEPARATOR}${toolName}`;
}

export interface ServerRecord {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ToolRecord {
  id: string;
  server_name: string;
  tool_name: string;
  description: string;
  input_schema: string; // JSON string
}

export interface ToolSummary {
  tool_name: string;
  description: string;
}

export interface SearchResult {
  id: string;
  server_name: string;
  tool_name: string;
  description: string;
  input_schema: object;
  rank: number;
}

export class Store {
  private db: Database.Database;

  constructor(dbPath: string = defaultDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    // Set restrictive permissions on the DB file (may contain env vars with secrets)
    try {
      chmodSync(dbPath, FILE_PERMISSION);
    } catch {
      // May fail on some platforms; non-fatal
    }

    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS servers (
        name TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        args TEXT NOT NULL DEFAULT '[]',
        env TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS tools (
        id TEXT PRIMARY KEY,
        server_name TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        input_schema TEXT NOT NULL DEFAULT '{}',
        harvested_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (server_name) REFERENCES servers(name) ON DELETE CASCADE
      );
    `);

    // FTS5 virtual table — CREATE VIRTUAL TABLE is not IF NOT EXISTS compatible in all SQLite versions
    const ftsExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tools_fts'")
      .get();
    if (!ftsExists) {
      this.db.exec(`
        CREATE VIRTUAL TABLE tools_fts USING fts5(
          id, tool_name, description, server_name,
          tokenize='porter unicode61'
        );
      `);
    }
  }

  // ── Servers ──────────────────────────────────────────────

  upsertServer(server: ServerRecord): void {
    this.db
      .prepare(
        `INSERT INTO servers (name, command, args, env, updated_at)
         VALUES (@name, @command, @args, @env, datetime('now'))
         ON CONFLICT(name) DO UPDATE SET
           command = @command, args = @args, env = @env,
           updated_at = datetime('now')`
      )
      .run({
        name: server.name,
        command: server.command,
        args: JSON.stringify(server.args),
        env: server.env ? JSON.stringify(server.env) : null,
      });
  }

  getServer(name: string): ServerRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM servers WHERE name = ?")
      .get(name) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.rowToServer(row);
  }

  listServers(): ServerRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM servers ORDER BY name")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToServer(r));
  }

  removeServer(name: string): void {
    // Must delete from FTS explicitly (CASCADE doesn't apply to virtual tables)
    this.runInTransaction(() => {
      this.db.prepare("DELETE FROM tools_fts WHERE server_name = ?").run(name);
      this.db.prepare("DELETE FROM tools WHERE server_name = ?").run(name);
      this.db.prepare("DELETE FROM servers WHERE name = ?").run(name);
    });
  }

  private rowToServer(row: Record<string, unknown>): ServerRecord {
    return {
      name: row.name as string,
      command: row.command as string,
      args: JSON.parse(row.args as string),
      env: row.env ? JSON.parse(row.env as string) : undefined,
    };
  }

  // ── Tools ────────────────────────────────────────────────

  upsertTools(serverName: string, tools: Omit<ToolRecord, "id" | "server_name">[]): void {
    this.runInTransaction(() => {
      // Remove old tools for this server
      this.db.prepare("DELETE FROM tools_fts WHERE server_name = ?").run(serverName);
      this.db.prepare("DELETE FROM tools WHERE server_name = ?").run(serverName);

      const insertTool = this.db.prepare(
        `INSERT INTO tools (id, server_name, tool_name, description, input_schema, harvested_at)
         VALUES (@id, @server_name, @tool_name, @description, @input_schema, datetime('now'))`
      );
      const insertFts = this.db.prepare(
        `INSERT INTO tools_fts (id, tool_name, description, server_name)
         VALUES (@id, @tool_name, @description, @server_name)`
      );

      for (const tool of tools) {
        const id = prefixToolName(serverName, tool.tool_name);
        const params = {
          id,
          server_name: serverName,
          tool_name: tool.tool_name,
          description: tool.description,
          input_schema: tool.input_schema,
        };
        insertTool.run(params);
        insertFts.run(params);
      }
    });
    logger.info(`Indexed ${tools.length} tools for server "${serverName}"`);
  }

  getToolCount(serverName: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM tools WHERE server_name = ?")
      .get(serverName) as { cnt: number };
    return row.cnt;
  }

  getToolsForServer(serverName: string): ToolSummary[] {
    return this.db
      .prepare("SELECT tool_name, description FROM tools WHERE server_name = ? ORDER BY tool_name")
      .all(serverName) as ToolSummary[];
  }

  getLastHarvestedAt(serverName: string): string | undefined {
    const row = this.db
      .prepare("SELECT harvested_at FROM tools WHERE server_name = ? ORDER BY harvested_at DESC LIMIT 1")
      .get(serverName) as { harvested_at: string } | undefined;
    return row?.harvested_at;
  }

  // ── FTS5 Search ──────────────────────────────────────────

  searchTools(query: string, limit: number = DEFAULT_SEARCH_LIMIT): SearchResult[] {
    const sanitized = this.sanitizeFtsQuery(query);
    if (!sanitized) return [];

    const rows = this.db
      .prepare(
        `SELECT f.id, f.tool_name, f.description, f.server_name,
                bm25(tools_fts, 0, 2, 5, 1) AS rank, t.input_schema
         FROM tools_fts f
         JOIN tools t ON t.id = f.id
         WHERE tools_fts MATCH @query
         ORDER BY rank
         LIMIT @limit`
      )
      .all({ query: sanitized, limit }) as Array<{
      id: string;
      tool_name: string;
      description: string;
      server_name: string;
      rank: number;
      input_schema: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      server_name: row.server_name,
      tool_name: row.tool_name,
      description: row.description,
      input_schema: JSON.parse(row.input_schema),
      rank: row.rank,
    }));
  }

  private sanitizeFtsQuery(query: string): string {
    // Remove FTS5 special characters to prevent injection, keep alphanumeric and spaces
    const cleaned = query.replace(/[^\w\s]/g, " ").trim();
    if (!cleaned) return "";
    // Convert to prefix search terms with OR semantics for better matching.
    // LLMs often search for multiple unrelated tool names in one query
    // (e.g., "browser navigate snapshot close") — AND would require ALL terms
    // in a single tool, returning nothing. OR finds tools matching ANY term,
    // with BM25 ranking putting the most relevant matches first.
    const terms = cleaned.split(/\s+/).filter(Boolean);
    return terms.map((t) => `"${t}"*`).join(" OR ");
  }

  // ── Transaction ──────────────────────────────────────────

  runInTransaction(fn: () => void): void {
    this.db.transaction(fn)();
  }

  // ── Lifecycle ────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}
