# Token Savings Analysis

mcp-broker saves tokens by replacing **T tool schemas** with **7 fixed meta-tool schemas**. These savings compound on every turn in a conversation because MCP tool schemas are resent with each LLM request.

This doc walks through the math so you can evaluate whether mcp-broker is worth adopting for your setup.

## Per-Turn Schema Cost

Every turn in an MCP conversation includes the full set of tool schemas in the system prompt.

| Setup | Schemas sent per turn | Tokens per turn |
|---|---|---|
| **Direct** (no broker) | T tool schemas | T × s |
| **With mcp-broker** | 7 meta-tool schemas | 7 × s_meta ≈ **1,400** |

Where:
- **T** = total number of tools across all your MCP servers
- **s** = average tokens per tool schema (typically 80-150 tokens depending on complexity)
- **s_meta** ≈ 200 tokens per meta-tool schema (7 meta-tools)

**Example:** With 100 tools at ~100 tokens each, direct sends 10,000 tokens/turn. mcp-broker sends 1,400 tokens/turn — an **86% reduction per turn**.

## Per-Task Cost

A single task (e.g., "create a GitHub issue") involves multiple turns. The two approaches differ in how tools are discovered and invoked.

### Direct (no broker)

- All T schemas are sent every turn — no discovery step needed
- The LLM picks the right tool from the full list
- Cost per task: **K × T × s** (where K = number of turns)

### With mcp-broker

- 7 meta-tool schemas sent every turn
- 1 extra turn for `search_tools` discovery (returns only relevant schemas)
- Cost per task: **(K + 1) × 1,400 + C + R_s**

Where:
- **C** = tokens for the `search_tools` call (~50 tokens)
- **R_s** = tokens in the search result (only matching tools, typically 2-5 schemas ≈ 200-600 tokens)

### Net per-task savings

```
Saved per task ≈ K × (T × s − 1,400) − (C + R_s)
```

The discovery overhead (C + R_s) is paid once. The per-turn schema reduction (T × s − 1,400) is earned on every turn.

## Batch Calling Savings (`call_tools`)

When a task requires multiple tool calls (e.g., "create an issue, then post to Slack"), the direct approach serializes them across separate turns. mcp-broker's `call_tools` accepts an array of invocations executed in parallel in a single turn.

### Direct: N tools across N turns

Each turn carries the full schema overhead plus the growing assistant/user message history:

```
Cost ≈ N × (T × s + C_call) + N(N-1)/2 × (a + r)
```

Where:
- **C_call** = tokens per tool call message (~50 tokens)
- **a** = average assistant message tokens per turn
- **r** = average tool result tokens per turn
- The triangular sum N(N-1)/2 accounts for the accumulating conversation history

### Broker: N tools in 1 turn

```
Cost ≈ 1,400 + C_search + R_s + C_batch + R_batch
```

Where:
- **C_batch** = tokens for the batched `call_tools` invocation
- **R_batch** = combined results from all N tool calls

### Net batch savings

```
Saved ≈ (N-1)(T × s + C_call) + N(N-1)/2 × (a + r)
```

With 3 tool calls and 100 tools: saves ~20,000+ tokens from eliminated turns alone, plus the compounding history savings.

## Conversation-Level Savings

Over a full conversation of K turns:

```
Direct cost:  K × T × s  (schemas resent every turn)
Broker cost:  K × 1,400 + C + R_s  (fixed overhead + one-time discovery)

Total saved ≈ K × (T × s − 1,400) − (C + R_s)
```

The savings grow linearly with conversation length. For a 20-turn conversation with 100 tools at 100 tokens/schema:

```
Saved ≈ 20 × (10,000 − 1,400) − 650
     ≈ 172,000 − 650
     ≈ 171,350 tokens
```

## Break-Even Guidance

mcp-broker adds a small fixed cost (discovery turn + meta-tool schemas). It only saves tokens when your total tool schemas exceed the broker's 7 meta-tool schemas.

| Total tools (T) | Savings per turn | Verdict |
|---|---|---|
| **< 14** | Negative or negligible | **Not worth it** — direct is simpler |
| **14-30** | 0 - 1,600 tokens/turn | **Modest win** — pays off in longer conversations |
| **30-50** | 1,600 - 3,600 tokens/turn | **Clear win** — saves dollars over a day of use |
| **50-100** | 3,600 - 8,600 tokens/turn | **Big win** — significant cost and latency reduction |
| **100+** | 8,600+ tokens/turn | **Massive win** — 80-90%+ schema token reduction |

The break-even point is approximately **T ≈ 14 tools** (where T × s ≈ 1,400). Below this, the broker's meta-tool overhead exceeds the savings.

## Concrete Examples

Assumptions: s = 100 tokens/schema, s_meta = 200 tokens/meta-schema (7 meta-tools), search overhead = 650 tokens.

| Tools (T) | Turns (K) | Direct (tokens) | Broker (tokens) | Saved | Saved (%) | Cost saved* |
|---|---|---|---|---|---|---|
| 20 | 5 | 10,000 | 7,650 | 2,350 | 24% | $0.01 |
| 20 | 20 | 40,000 | 28,650 | 11,350 | 28% | $0.03 |
| 50 | 5 | 25,000 | 7,650 | 17,350 | 69% | $0.05 |
| 50 | 20 | 100,000 | 28,650 | 71,350 | 71% | $0.21 |
| 100 | 5 | 50,000 | 7,650 | 42,350 | 85% | $0.13 |
| 100 | 20 | 200,000 | 28,650 | 171,350 | 86% | $0.51 |
| 200 | 5 | 100,000 | 7,650 | 92,350 | 92% | $0.28 |
| 200 | 20 | 400,000 | 28,650 | 371,350 | 93% | $1.11 |

*\*Cost estimates at $3/M input tokens (Claude Sonnet). Actual savings vary by model and pricing tier. These are per-conversation savings — multiply by daily conversations for total impact.*

### Batch calling example

A task requiring 5 parallel tool calls with 100 registered tools:

| | Direct (5 turns) | Broker (1 batched turn) |
|---|---|---|
| Schema tokens | 50,000 | 1,400 |
| History accumulation | ~2,500 | 0 |
| Discovery overhead | 0 | ~650 |
| **Total** | **~52,500** | **~2,050** |
| **Savings** | | **~50,450 tokens (96%)** |

## Prompt Caching Impact

The raw token savings above assume full-price input tokens on every turn. In practice, both Anthropic and OpenAI cache repeated system prompt content (including tool schemas) across turns within a conversation, at a 90% discount (you pay only 10% of the full input price for cached tokens).

Since tool schemas are identical across turns, they hit the cache after the first turn. This significantly reduces the effective per-turn cost of direct tool schemas.

### Adjusted savings with prompt caching

With caching, the effective per-turn schema cost for direct is:

```
Turn 1:  T × s  (full price, cache miss)
Turn 2+: T × s × 0.1  (cache hit, 90% discount)
```

For a K-turn conversation:

```
Direct cost (cached) ≈ T × s + (K − 1) × T × s × 0.1
                     = T × s × (1 + (K − 1) × 0.1)

Broker cost          ≈ K × 1,400 + C + R_s
```

**Example:** 100 tools, 20 turns, 90% cache discount:

```
Direct (cached) ≈ 10,000 × (1 + 19 × 0.1) = 10,000 × 2.9 = 29,000 tokens (effective)
Broker          ≈ 20 × 1,400 + 650 = 28,650 tokens

Savings ≈ 350 tokens (1.2%)
```

Compare to the uncached estimate of 171,350 tokens saved (86%). Prompt caching eliminates most of the raw token savings.

### When the broker still saves money

Even with prompt caching, the broker provides cost advantages in specific scenarios:

1. **First-turn cost** — no caching on the first turn. With 200+ tools, the first turn alone can cost $0.03+ more than the broker.
2. **Cross-conversation savings** — prompt cache has a TTL (typically 5 minutes). New conversations or long gaps between turns pay full price again.
3. **Batch calling** — `call_tools` parallelizes N independent tool calls into 1 turn, eliminating (N−1) turns of conversation history growth (not cacheable).
4. **Very large tool counts (200+)** — even cached, the schema overhead is significant when hundreds of tools compete for attention.

### Where the broker's value is non-monetary

The broker's primary advantages with prompt caching enabled:

- **Tool selection accuracy** — LLMs perform measurably worse at selecting the right tool as the number of available tools grows. The broker's search-then-call pattern narrows the visible tools to only the relevant ones.
- **Centralized management** — one `servers.json` shared across all AI clients. Add/remove servers once, all clients see the change.
- **Dynamic discovery** — the LLM can add new MCP servers at runtime via `add_mcp_server`, without reconfiguring any client.

## Multi-Query Search

`search_tools` accepts a `queries` array to search for multiple aspects of a task in a single call. Each query runs independently with its own limit, results are deduplicated by tool ID (keeping the best BM25 rank), and returned sorted.

This eliminates repeat `search_tools` calls. Instead of:

```
search_tools("browser navigate")  → 1 turn
search_tools("browser title")     → 1 turn (needed tools not in first result)
```

The LLM sends one call:

```
search_tools(queries: ["browser navigate", "browser title", "browser close"])  → 1 turn
```

### E2E Cost Comparison

Tested with vibium (81 browser automation tools) on Claude Code — navigate to https://example.com, get the page title, close the browser. Each run uses a fully isolated temp directory with no shared MCP configs, ensuring the direct run has zero broker overhead and the broker run has a fresh instance.

| | Turns | Tool calls | Cost |
|---|---|---|---|
| **Direct MCP** (81 tool schemas every turn) | 6 | 4 separate calls | $0.0950 |
| **mcp-broker** (7 meta-tools + multi-query search) | 4 | 1 search + 1 batched call | **$0.0708** |
| **Savings** | | | **25.5%** |

The broker achieved fewer turns despite prompt caching helping direct MCP. Multi-query search found all needed tools in one call, then `call_tools` executed the entire workflow (navigate → get_title → stop) in a single batched turn.

**Why this matters:** Even in a short 4-6 turn conversation with prompt caching active, the broker is 25% cheaper than direct MCP with 81 tools. The savings come from turn elimination (fewer API round-trips = less conversation history re-sent), not just schema reduction. In longer conversations the advantage compounds.

## Key Takeaways

1. **Schema overhead dominates (without caching)** — tool schemas are the largest hidden cost in MCP conversations
2. **Prompt caching changes the math** — with Anthropic/OpenAI caching (90% discount), repeated tool schemas cost 10% of full price, reducing the broker's raw token savings
3. **Multi-query search reduces turns** — searching for multiple aspects at once eliminates repeat `search_tools` calls, which is the main broker overhead
4. **Batch calling amplifies savings** — parallelizing N calls into 1 turn eliminates (N-1) turns of overhead (conversation history is not cacheable)
5. **More tools = more savings** — the broker's fixed cost is amortized across more tools
6. **Break-even shifts with caching** — without caching ~14 tools; with 90% caching ~80+ tools for meaningful cost savings (multi-query helps close the gap)
7. **Accuracy and management are the primary wins** — fewer visible tools = better LLM tool selection + centralized config across all clients
