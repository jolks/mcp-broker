# Token Savings Analysis

mcp-broker saves tokens by replacing **T tool schemas** with **8 fixed meta-tool schemas**. These savings compound on every turn in a conversation because MCP tool schemas are resent with each LLM request.

This doc walks through the math so you can evaluate whether mcp-broker is worth adopting for your setup.

## Per-Turn Schema Cost

Every turn in an MCP conversation includes the full set of tool schemas in the system prompt.

| Setup | Schemas sent per turn | Tokens per turn |
|---|---|---|
| **Direct** (no broker) | T tool schemas | T × s |
| **With mcp-broker** | 8 meta-tool schemas | 8 × s_meta ≈ **1,600** |

Where:
- **T** = total number of tools across all your MCP servers
- **s** = average tokens per tool schema (typically 80-150 tokens depending on complexity)
- **s_meta** ≈ 200 tokens per meta-tool schema

**Example:** With 100 tools at ~100 tokens each, direct sends 10,000 tokens/turn. mcp-broker sends 1,600 tokens/turn — an **84% reduction per turn**.

## Per-Task Cost

A single task (e.g., "create a GitHub issue") involves multiple turns. The two approaches differ in how tools are discovered and invoked.

### Direct (no broker)

- All T schemas are sent every turn — no discovery step needed
- The LLM picks the right tool from the full list
- Cost per task: **K × T × s** (where K = number of turns)

### With mcp-broker

- 8 meta-tool schemas sent every turn
- 1 extra turn for `search_tools` discovery (returns only relevant schemas)
- Cost per task: **(K + 1) × 1,600 + C + R_s**

Where:
- **C** = tokens for the `search_tools` call (~50 tokens)
- **R_s** = tokens in the search result (only matching tools, typically 2-5 schemas ≈ 200-600 tokens)

### Net per-task savings

```
Saved per task ≈ K × (T × s − 1,600) − (C + R_s)
```

The discovery overhead (C + R_s) is paid once. The per-turn schema reduction (T × s − 1,600) is earned on every turn.

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
Cost ≈ 1,600 + C_search + R_s + C_batch + R_batch
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
Broker cost:  K × 1,600 + C + R_s  (fixed overhead + one-time discovery)

Total saved ≈ K × (T × s − 1,600) − (C + R_s)
```

The savings grow linearly with conversation length. For a 20-turn conversation with 100 tools at 100 tokens/schema:

```
Saved ≈ 20 × (10,000 − 1,600) − 650
     ≈ 168,000 − 650
     ≈ 167,350 tokens
```

## Break-Even Guidance

mcp-broker adds a small fixed cost (discovery turn + meta-tool schemas). It only saves tokens when your total tool schemas exceed the broker's 8 meta-tool schemas.

| Total tools (T) | Savings per turn | Verdict |
|---|---|---|
| **< 16** | Negative or negligible | **Not worth it** — direct is simpler |
| **16-30** | 0 - 1,400 tokens/turn | **Modest win** — pays off in longer conversations |
| **30-50** | 1,400 - 3,400 tokens/turn | **Clear win** — saves dollars over a day of use |
| **50-100** | 3,400 - 8,400 tokens/turn | **Big win** — significant cost and latency reduction |
| **100+** | 8,400+ tokens/turn | **Massive win** — 80-90%+ schema token reduction |

The break-even point is approximately **T ≈ 16 tools** (where T × s ≈ 1,600). Below this, the broker's meta-tool overhead exceeds the savings.

## Concrete Examples

Assumptions: s = 100 tokens/schema, s_meta = 200 tokens/meta-schema, search overhead = 650 tokens.

| Tools (T) | Turns (K) | Direct (tokens) | Broker (tokens) | Saved | Saved (%) | Cost saved* |
|---|---|---|---|---|---|---|
| 20 | 5 | 10,000 | 8,650 | 1,350 | 14% | $0.00 |
| 20 | 20 | 40,000 | 32,650 | 7,350 | 18% | $0.02 |
| 50 | 5 | 25,000 | 8,650 | 16,350 | 65% | $0.05 |
| 50 | 20 | 100,000 | 32,650 | 67,350 | 67% | $0.20 |
| 100 | 5 | 50,000 | 8,650 | 41,350 | 83% | $0.12 |
| 100 | 20 | 200,000 | 32,650 | 167,350 | 84% | $0.50 |
| 200 | 5 | 100,000 | 8,650 | 91,350 | 91% | $0.27 |
| 200 | 20 | 400,000 | 32,650 | 367,350 | 92% | $1.10 |

*\*Cost estimates at $3/M input tokens (Claude Sonnet). Actual savings vary by model and pricing tier. These are per-conversation savings — multiply by daily conversations for total impact.*

### Batch calling example

A task requiring 5 parallel tool calls with 100 registered tools:

| | Direct (5 turns) | Broker (1 batched turn) |
|---|---|---|
| Schema tokens | 50,000 | 1,600 |
| History accumulation | ~2,500 | 0 |
| Discovery overhead | 0 | ~650 |
| **Total** | **~52,500** | **~2,250** |
| **Savings** | | **~50,250 tokens (96%)** |

## Key Takeaways

1. **Schema overhead dominates** — tool schemas are the largest hidden cost in MCP conversations
2. **Savings compound** — every additional turn multiplies the per-turn savings
3. **Batch calling amplifies savings** — parallelizing N calls into 1 turn eliminates (N-1) turns of overhead
4. **More tools = more savings** — the broker's fixed cost is amortized across more tools
5. **Break-even is ~16 tools** — below this, stick with direct configuration
