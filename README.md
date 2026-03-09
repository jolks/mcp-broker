# mcp-broker

**One MCP server for all your tools — works with any AI client, configure once, use everywhere.**

Configure one MCP server instead of dozens. mcp-broker acts as a single gateway to all your MCP servers, centralizing access across every AI tool on your device.

## The Problem

1. **Context bloat** — 10+ MCP servers exposing 100+ tools means every tool schema is sent to the LLM on every request. This degrades tool selection accuracy — LLMs perform worse at choosing the right tool as the number of visible tools grows.

2. **Fragmented configs** — MCP servers are scattered across Cursor, Claude Desktop, Windsurf, and Claude Code configs. Add a new server? Update 4 files. Remove one? Hope you didn't miss a config.

## How mcp-broker Solves It

mcp-broker maintains a single `servers.json` registry. Any AI client that connects to mcp-broker gets access to all your MCP servers. Set up once, add mcp-broker to each client, done. Because it speaks standard MCP, it works with any AI client or LLM that supports the protocol — no vendor lock-in.

Instead of exposing all tools, mcp-broker exposes **7 meta-tools**. The LLM searches for relevant tools on-demand via FTS5 full-text search, then calls them through the broker. `search_tools` supports multi-query search — the LLM can search for multiple aspects of a task in a single call:

```
LLM → search_tools(queries: ["browser navigate", "page title", "browser close"])
    → FTS5 lookup per query → deduplicated, ranked results
LLM → call_tools([{server_name: "vibium", tool_name: "browser_navigate", arguments: {...}}, ...])
    → broker routes each invocation to its downstream server
```

## Quick Start

```bash
# One-time setup: import servers from your existing config
npx mcp-broker setup

# See what got imported
npx mcp-broker list
```

`setup` auto-detects your MCP config (Cursor, Claude Desktop, Windsurf, Claude Code), imports all servers into `~/.mcp-broker/servers.json`, and lets you pick exactly which configs to rewrite.

```
$ npx mcp-broker setup

Found config: Cursor — ~/.cursor/mcp.json (3 servers)

Server   Status  Tools
────────────────────────
github   OK      12
slack    OK      8
fs       OK      3

3 server(s) imported (3 healthy, 0 unhealthy)

Configure these AI tools to use mcp-broker:

  1. Cursor — ~/.cursor/mcp.json (source, will be rewritten)
  2. Claude Desktop — ~/Library/.../claude_desktop_config.json
  3. Windsurf — ~/.codeium/windsurf/mcp_config.json

Select [1-3, all, none] (default: all): 1,2

  ✓ Cursor
  ✓ Claude Desktop

Done! 2 AI tools now share 3 MCP servers via mcp-broker.
```

After setup, manage servers through the LLM or edit `servers.json` directly.

```
  Cursor         ──►┌─────────────┐
  Claude Desktop ──►│ mcp-broker  │──► GitHub, Filesystem, Slack, ...
  Windsurf       ──►│             │
  Claude Code    ──►└─────────────┘
                     servers.json (single source of truth)
```

**Typical workflow:**
1. `npx mcp-broker setup` — imports servers from your config and configures all AI tools in one step
2. All clients now share the same MCP servers — add or remove once, applies everywhere

## Meta-Tools

| Tool | Description |
|---|---|
| `search_tools` | Full-text search across all servers' tools. Accepts `query` (single) or `queries` (array for multi-aspect search in one call). Returns names, descriptions, and input schemas. Description is dynamic — includes actual server names and total tool count. |
| `call_tools` | Invoke one or more discovered tools via search_tools results. Multiple invocations execute in parallel. |
| `add_mcp_server` | Register a new MCP server. Harvests and indexes its tools. |
| `remove_mcp_server` | Remove a server and its indexed tools. |
| `list_mcp_servers` | List all servers with connection status and tool counts. Guides toward search_tools when search returns no results. |
| `get_mcp_server` | Get detailed info for a server including version, all tool names. Guides toward search_tools for schema lookup. |
| `update_mcp_server` | Update a server's config (command, args, env). Re-harvests and reconnects. |

## Architecture

```
┌─────────────┐      ┌─────────────┐      ┌──────────────────┐
│  LLM client │◄────►│  mcp-broker │◄────►│  GitHub server   │
│             │ MCP  │             │ MCP  │  Filesystem srv  │
│             │      │  SQLite DB  │      │  Slack server    │
│             │      │  FTS5 index │      │  ...             │
└─────────────┘      └─────────────┘      └──────────────────┘
```

- **Registry** — `servers.json` is the source of truth. SQLite is a rebuildable index — delete the DB and it's rebuilt on next startup.
- **Store** — SQLite + FTS5 with Porter stemming for fast full-text search. On startup, servers with tools older than 5 minutes are re-harvested in the background (non-blocking). To pick up tool changes from a server upgrade, restart mcp-broker or your LLM client.
- **Pool** — Eager connection manager with auto-reconnect.
- **Harvester** — Discovers tools from a server via `tools/list` with pagination.

## CLI Commands

```bash
npx mcp-broker serve              # Start the MCP server
npx mcp-broker setup [path]       # Import servers, health-check, configure AI tools
npx mcp-broker list               # Show registered servers and tool counts
npx mcp-broker refresh [name]     # Re-harvest tools from servers
npx mcp-broker restore <config>   # Restore a client config (e.g. ~/.cursor/mcp.json) from backup
```

## Token Savings

mcp-broker replaces all your tool schemas with 7 fixed meta-tool schemas (~1,400 tokens). Savings compound on every turn.

| Tools | 5-turn task | 20-turn task | Savings |
|---|---|---|---|
| 20 | 2,350 tokens saved | 11,350 saved | ~28% |
| 50 | 17,350 tokens saved | 71,350 saved | ~71% |
| 100 | 42,350 tokens saved | 171,350 saved | ~86% |
| 200 | 92,350 tokens saved | 371,350 saved | ~93% |

Break-even is ~14 tools. Below that, direct configuration is simpler.

**Prompt caching note:** Some providers (Anthropic, OpenAI) cache repeated tool schemas at a discount on subsequent turns, which reduces direct MCP's per-turn cost. The broker still saves by eliminating turns entirely (batching multiple tool calls into one). See [Token Savings Analysis](docs/token-savings.md) for the full breakdown including the impact of prompt caching.

## Requirements

- Node.js >= 20
- SQLite (bundled via better-sqlite3)

## Development

```bash
pnpm install
pnpm run build          # TypeScript → dist/
pnpm run dev            # tsc --watch
pnpm test               # Run tests
pnpm start serve        # Run locally (uses .mcp-broker/ instead of ~/.mcp-broker)
```

## License

MIT
