# mcp-broker

**One MCP server for all your tools — configure once, use everywhere.**

Configure one MCP server instead of dozens. mcp-broker acts as a single gateway to all your MCP servers, centralizing access across every AI tool on your device.

## The Problem

1. **Context bloat** — 10+ MCP servers exposing 100+ tools means every tool schema is sent to the LLM on every request. This wastes context tokens and degrades tool selection accuracy.

2. **Fragmented configs** — MCP servers are scattered across Cursor, Claude Desktop, Windsurf, and Claude Code configs. Add a new server? Update 4 files. Remove one? Hope you didn't miss a config.

## How mcp-broker Solves It

mcp-broker maintains a single `servers.json` registry. Any AI client that connects to mcp-broker gets access to all your MCP servers. Set up once, add mcp-broker to each client, done.

Instead of exposing all tools, mcp-broker exposes **8 meta-tools**. The LLM searches for relevant tools on-demand via FTS5 full-text search, then calls them through the broker:

```
LLM → search_tools("github issue")     → FTS5 lookup → returns tool schemas
LLM → call_tools([{server_name: "github", tool_name: "create_issue", arguments: {...}}])
                                        → broker routes to downstream server
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
| `search_tools` | Full-text search across all servers' tools. Returns names, descriptions, and input schemas. |
| `call_tools` | Invoke one or more discovered tools. Multiple invocations execute in parallel. |
| `add_mcp_server` | Register a new MCP server. Harvests and indexes its tools. |
| `remove_mcp_server` | Remove a server and its indexed tools. |
| `list_mcp_servers` | List all servers with connection status and tool counts. |
| `get_mcp_server` | Get detailed info for a single server including config and tool listing. |
| `update_mcp_server` | Update a server's config (command, args, env). Re-harvests and reconnects. |
| `refresh_tools` | Re-harvest tools from one or all servers. |

## Architecture

```
┌─────────────┐      ┌─────────────┐      ┌──────────────────┐
│  LLM client │◄────►│  mcp-broker │◄────►│  GitHub server   │
│             │ MCP  │             │ MCP  │  Filesystem srv  │
│             │stdio │  SQLite DB  │stdio │  Slack server    │
│             │      │  FTS5 index │      │  ...             │
└─────────────┘      └─────────────┘      └──────────────────┘
```

- **Registry** — `servers.json` is the source of truth. SQLite is a rebuildable index — delete the DB and it's rebuilt on next startup.
- **Store** — SQLite + FTS5 with Porter stemming for fast full-text search.
- **Pool** — Eager connection manager with auto-reconnect.
- **Harvester** — Discovers tools from a server via `tools/list` with pagination.

## CLI Commands

```bash
npx mcp-broker serve              # Start the MCP server (stdio)
npx mcp-broker setup [path]       # Import servers, health-check, configure AI tools
npx mcp-broker list               # Show registered servers and tool counts
npx mcp-broker refresh [name]     # Re-harvest tools from servers
npx mcp-broker restore <config>   # Restore a client config (e.g. ~/.cursor/mcp.json) from backup
```

## Token Savings

mcp-broker replaces all your tool schemas with 8 fixed meta-tool schemas (~1,600 tokens). Savings compound on every turn.

| Tools | 5-turn task | 20-turn task | Savings |
|---|---|---|---|
| 20 | 1,350 tokens saved | 7,350 saved | ~18% |
| 50 | 11,350 tokens saved | 47,350 saved | ~60% |
| 100 | 36,350 tokens saved | 147,350 saved | ~82% |
| 200 | 86,350 tokens saved | 347,350 saved | ~91% |

Break-even is ~16 tools. Below that, direct configuration is simpler. See [Token Savings Analysis](docs/token-savings.md) for more details.

## Requirements

- Node.js >= 18
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
