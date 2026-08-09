# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run

```bash
pnpm run build          # TypeScript → dist/
pnpm run dev            # tsc --watch
pnpm start serve          # Start MCP server (stdio), uses local .mcp-broker/
pnpm start setup [path]   # Import servers, health-check, configure AI tools
pnpm start list           # Show registered servers
pnpm start refresh [name] # Re-harvest tools
pnpm start restore <path> # Restore config from backup
```

The `start` script sets `MCP_BROKER_HOME=./.mcp-broker` so local dev uses a project-local directory instead of `~/.mcp-broker`.

```bash
pnpm test               # Run tests (vitest)
pnpm run test:watch     # Watch mode
pnpm run test:coverage  # Run tests with v8 coverage report
pnpm run test:e2e       # E2E tests via claude -p (costs tokens, see below)
pnpm run lint           # Run ESLint
pnpm run lint:fix       # Run ESLint with auto-fix
```

## Architecture

mcp-broker is an MCP server that acts as a gateway to many downstream MCP servers. Instead of configuring dozens of MCP servers (flooding the LLM context with hundreds of tool schemas), you configure one: mcp-broker. It exposes 7 fixed meta-tools. Discovery works like an LLM using CLI tools — browse the command list, read the help, then run: `list_tools` returns a compact one-line-per-tool listing grouped by server (optionally filtered with `server_names`), `describe_tools` returns full input schemas for the specific tools the LLM picked, and `call_tools` invokes them by `server_name` and `tool_name` (array of invocations, parallel by default, `sequential: true` for ordered steps). The LLM does the "search" by reading the list — there is no server-side search index.

### Data flow

```
LLM → list_tools()                    → one compact line per tool, grouped by server
LLM → describe_tools(tools: [{server_name: "vibium", tool_name: "browser_navigate"}, ...])
    → full input schemas for just those tools
LLM → call_tools(invocations: [{server_name: "vibium", tool_name: "browser_navigate", arguments: {...}}, ...])
    → broker → pool.getClient("vibium") → client.callTool("browser_navigate", {...})
    → result passed through to LLM
```

### Module responsibilities

- **index.ts** — CLI entry point (commander). Creates Store/Pool/Registry/Broker, wires them together.
- **server.ts** — Low-level MCP `Server` (not `McpServer`). Defines 7 meta-tools with annotations. `list_tools` description is dynamically built with actual server names and tool counts via `buildDynamicTools()`. Response text guides the LLM through the discovery loop: list → describe → call. `truncateDescription()` caps listing lines at `LIST_TOOLS_DESCRIPTION_MAX_CHARS`.
- **broker.ts** — Orchestration layer. Owns discovery (`listTools`, `describeTools`), tool calling, server add/remove/refresh. Connects store, pool, registry, and harvester. Syncs registry → SQLite on startup.
- **store.ts** — SQLite via better-sqlite3. Tables: `servers`, `tools`. DB at `$MCP_BROKER_HOME/broker.db`. Plain rebuildable index of harvested tool schemas; a legacy `tools_fts` table is dropped on open.
- **transport.ts** — Transport creation and URL connection logic. Exports `createStdioTransport()`, `createStreamableTransport()`, `createSseTransport()`, and `connectUrl()` which handles Streamable HTTP → SSE fallback (per MCP spec). Used by both pool and harvester.
- **pool.ts** — Eager connection manager. Connects to all servers on startup (stdio via `createStdioTransport`, URL via `connectUrl`). Auto-reconnects on disconnect. `Map<serverName, {client, transport}>`.
- **harvester.ts** — One-shot tool discovery. `harvestTools(server: ServerRecord)` connects to a server (stdio or URL), calls `tools/list` with pagination, collects schemas, shuts down. 30s timeout.
- **registry.ts** — Manages `servers.json` (the source of truth for server definitions). Pure standard MCP config format. CRUD operations: addServer, removeServer, listEntries, importServers.
- **config.ts** — App-wide defaults: identity (`VERSION`, `SERVER_NAME`), path helpers (`brokerHome()`, `dbPath()`, `registryPath()`, `backupsDir()`), permissions (`FILE_PERMISSION`), timeouts, search constants, and utilities (`buildEnv`, `raceTimeout`). Merged from former `paths.ts` and `utils.ts`.
- **client-config.ts** — Reads/writes MCP client config JSON files (Cursor, Claude Desktop format). Handles backup/restore. Cross-client helpers: `listKnownConfigPaths()`, `addBrokerToConfig()`, `hasBrokerEntry()`. Conversion helpers: `entryToRecord()`, `recordToEntry()` bridge between registry entries and store records.
- **setup-rewrite.ts** — Config rewrite pick-list logic for `setup` command. `parseSelection()` parses user input into indices. `promptAndRewriteConfigs()` displays candidates, prompts user, and rewrites selected configs. Uses `PromptIO` interface for testability.
- **logger.ts** — stderr-only (stdout is reserved for MCP stdio protocol).

### MCP SDK import paths (ESM)

All imports require `.js` extension even in TypeScript:
- `@modelcontextprotocol/sdk/server/index.js` — `Server`
- `@modelcontextprotocol/sdk/server/stdio.js` — `StdioServerTransport`
- `@modelcontextprotocol/sdk/client/index.js` — `Client`
- `@modelcontextprotocol/sdk/client/stdio.js` — `StdioClientTransport`
- `@modelcontextprotocol/sdk/client/streamableHttp.js` — `StreamableHTTPClientTransport`
- `@modelcontextprotocol/sdk/client/sse.js` — `SSEClientTransport`
- `@modelcontextprotocol/sdk/shared/transport.js` — `Transport` type
- `@modelcontextprotocol/sdk/types.js` — schemas and types (`ListToolsRequestSchema`, `CallToolRequestSchema`, `Tool`, `CallToolResult`, `McpError`, `ErrorCode`)

### Key constraints

- **`servers.json` is source of truth** — `$MCP_BROKER_HOME/servers.json` is the canonical server registry (pure standard MCP config format). SQLite is a rebuildable index. If the DB is deleted, it is rebuilt from `servers.json` on startup.
- **`MCP_BROKER_HOME` env var** — overrides the base directory (default `~/.mcp-broker`). All paths are derived from it: `broker.db`, `servers.json`, `backups/`. Used by tests to isolate from `~/.mcp-broker`.
- **stdout is sacred in `serve`** — the `serve` command uses stdio transport, so all logging there must go to stderr (`logger.ts`). CLI commands (`setup`, `list`, `refresh`, `restore`) are normal terminal programs and use `console.log` for user-facing output freely.
- **DB permissions** — `broker.db` is chmod 0600 because it may contain env vars with API keys.
- **Registry permissions** — `servers.json` is chmod 0600 because it may contain env vars with API keys.
- **Backup before rewrite** — the `setup` command always verifies backup size > 0 before overwriting the original config.
- **Tool ID prefixing** — tools are stored with `server__tool` IDs via `prefixToolName()` in `store.ts`.
- **DB CHECK constraints** — `servers` table enforces that exactly one of `command` or `url` is non-null via CHECK constraints. Applied to new DBs and DBs going through `migrateUrlColumns()`.

### Running E2E tests

E2E tests spawn `claude -p` as a subprocess, so they require:
- The `claude` CLI installed and authenticated
- Each run costs real API tokens (~$0.25 for the full suite)
- If `ANTHROPIC_API_KEY` is set, `claude` will use it (and bill the API). To use your Claude Max/Pro subscription instead: `unset ANTHROPIC_API_KEY && pnpm run test:e2e`

The `pnpm run test:e2e` script sets `RUN_E2E=1` automatically. Output may appear blank in some environments because vitest's stdio is captured; redirect to a file to see results:

```bash
pnpm run test:e2e > /tmp/e2e.txt 2>&1 && cat /tmp/e2e.txt
```
