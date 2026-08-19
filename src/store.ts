import Database from "better-sqlite3";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "./logger.js";
import { dbPath as defaultDbPath, FILE_PERMISSION, TOOL_PREFIX_SEPARATOR } from "./config.js";

/** Build prefixed tool name: "server__tool" */
export function prefixToolName(serverName: string, toolName: string): string {
  return `${serverName}${TOOL_PREFIX_SEPARATOR}${toolName}`;
}

export interface StdioServerRecord {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface UrlServerRecord {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export type ServerRecord = StdioServerRecord | UrlServerRecord;

export function isUrlServer(server: ServerRecord): server is UrlServerRecord {
  return "url" in server;
}

export interface ToolRecord {
  id: string;
  server_name: string;
  tool_name: string;
  description: string;
  input_schema: string; // JSON string
}

export interface ToolListing {
  server_name: string;
  tool_name: string;
  description: string;
}

export interface ToolRef {
  server_name: string;
  tool_name: string;
}

export interface ToolDetail extends ToolListing {
  input_schema: object;
}

function serversTableSql(tableName: string = "servers"): string {
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
    name TEXT PRIMARY KEY,
    command TEXT,
    args TEXT NOT NULL DEFAULT '[]',
    env TEXT,
    url TEXT,
    headers TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    -- command vs url mutual exclusivity enforced at DB level
    CHECK (command IS NOT NULL OR url IS NOT NULL),
    CHECK (NOT (command IS NOT NULL AND url IS NOT NULL))
  )`;
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
      ${serversTableSql()};

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

    // Migrate existing DBs: add url/headers columns and relax command NOT NULL
    this.migrateUrlColumns();

    // Drop legacy FTS5 index (search was replaced by list_tools/describe_tools)
    this.db.exec("DROP TABLE IF EXISTS tools_fts;");
  }

  private migrateUrlColumns(): void {
    // Check if url column already exists
    const columns = this.db.pragma("table_info(servers)") as Array<{ name: string }>;
    const hasUrl = columns.some((c) => c.name === "url");
    if (hasUrl) return;

    // Recreate the table to drop NOT NULL from command and add url/headers.
    // Uses db.transaction() for automatic rollback on failure.
    this.db.transaction(() => {
      this.db.exec(serversTableSql("servers_new") + ";");
      this.db.exec(`
        INSERT INTO servers_new (name, command, args, env, created_at, updated_at)
          SELECT name, command, args, env, created_at, updated_at FROM servers;
      `);
      this.db.exec("DROP TABLE servers;");
      this.db.exec("ALTER TABLE servers_new RENAME TO servers;");
    })();
    logger.info("Migrated servers table to support URL-based servers");
  }

  // ── Servers ──────────────────────────────────────────────

  upsertServer(server: ServerRecord): void {
    if (isUrlServer(server)) {
      // args/env set to defaults — unused for URL servers but column is NOT NULL
      this.db
        .prepare(
          `INSERT INTO servers (name, command, args, env, url, headers, updated_at)
           VALUES (@name, NULL, '[]', NULL, @url, @headers, datetime('now'))
           ON CONFLICT(name) DO UPDATE SET
             command = NULL, args = '[]', env = NULL,
             url = @url, headers = @headers,
             updated_at = datetime('now')`
        )
        .run({
          name: server.name,
          url: server.url,
          headers: server.headers ? JSON.stringify(server.headers) : null,
        });
    } else {
      this.db
        .prepare(
          `INSERT INTO servers (name, command, args, env, url, headers, updated_at)
           VALUES (@name, @command, @args, @env, NULL, NULL, datetime('now'))
           ON CONFLICT(name) DO UPDATE SET
             command = @command, args = @args, env = @env,
             url = NULL, headers = NULL,
             updated_at = datetime('now')`
        )
        .run({
          name: server.name,
          command: server.command,
          args: JSON.stringify(server.args),
          env: server.env ? JSON.stringify(server.env) : null,
        });
    }
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
    this.runInTransaction(() => {
      this.db.prepare("DELETE FROM tools WHERE server_name = ?").run(name);
      this.db.prepare("DELETE FROM servers WHERE name = ?").run(name);
    });
  }

  private rowToServer(row: Record<string, unknown>): ServerRecord {
    if (row.url) {
      return {
        name: row.name as string,
        url: row.url as string,
        headers: row.headers ? JSON.parse(row.headers as string) : undefined,
      };
    }
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
      this.db.prepare("DELETE FROM tools WHERE server_name = ?").run(serverName);

      const insertTool = this.db.prepare(
        `INSERT INTO tools (id, server_name, tool_name, description, input_schema, harvested_at)
         VALUES (@id, @server_name, @tool_name, @description, @input_schema, datetime('now'))`
      );

      for (const tool of tools) {
        insertTool.run({
          id: prefixToolName(serverName, tool.tool_name),
          server_name: serverName,
          tool_name: tool.tool_name,
          description: tool.description,
          input_schema: tool.input_schema,
        });
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

  listAllTools(serverNames?: string[]): ToolListing[] {
    if (serverNames && serverNames.length > 0) {
      const placeholders = serverNames.map(() => "?").join(", ");
      return this.db
        .prepare(
          `SELECT server_name, tool_name, description FROM tools
           WHERE server_name IN (${placeholders})
           ORDER BY server_name, tool_name`
        )
        .all(...serverNames) as ToolListing[];
    }
    return this.db
      .prepare("SELECT server_name, tool_name, description FROM tools ORDER BY server_name, tool_name")
      .all() as ToolListing[];
  }

  getToolDetails(refs: ToolRef[]): ToolDetail[] {
    // Match on the (server_name, tool_name) pair — the concatenated id is
    // ambiguous when either name itself contains the "__" separator
    const stmt = this.db.prepare(
      "SELECT server_name, tool_name, description, input_schema FROM tools WHERE server_name = ? AND tool_name = ?"
    );
    const details: ToolDetail[] = [];
    for (const ref of refs) {
      const row = stmt.get(ref.server_name, ref.tool_name) as
        | { server_name: string; tool_name: string; description: string; input_schema: string }
        | undefined;
      if (row) {
        details.push({ ...row, input_schema: JSON.parse(row.input_schema) as object });
      }
    }
    return details;
  }

  getLastHarvestedAt(serverName: string): string | undefined {
    const row = this.db
      .prepare("SELECT harvested_at FROM tools WHERE server_name = ? ORDER BY harvested_at DESC LIMIT 1")
      .get(serverName) as { harvested_at: string } | undefined;
    return row?.harvested_at;
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
