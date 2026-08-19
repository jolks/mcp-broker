import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { copyEnv, buildBroker, writeEchoConfig, seedBroker } from "./e2e-helpers.js";

const ROOT = resolve(import.meta.dirname, "..");
const shouldRun = process.env.RUN_E2E === "1";

// Model to test with, e.g. E2E_MODEL=claude-haiku-4-5-20251001 (or alias "haiku").
// Unset = the claude CLI's default model.
const E2E_MODEL = process.env.E2E_MODEL;

// Use a temp directory so we don't touch ~/.mcp-broker. The generated echo
// config lives here too, so parallel suites never share files.
const TEST_DIR = mkdtempSync(join(tmpdir(), "mcp-broker-e2e-"));
const ECHO_CONFIG_PATH = join(TEST_DIR, "echo-config.json");

// Build env: strip CLAUDECODE (allows nested invocation), set MCP_BROKER_HOME
const testEnv = copyEnv("CLAUDECODE");
testEnv.MCP_BROKER_HOME = TEST_DIR;

// Generate a temporary .mcp.json that passes MCP_BROKER_HOME to the broker server.
// --mcp-config uses only this file — it does NOT merge with ~/.claude.json,
// so tests won't conflict if the user has mcp-broker configured globally.
const TEST_MCP_CONFIG = join(TEST_DIR, "mcp.json");

interface ClaudeResult {
  result: string;
  num_turns: number;
  duration_ms: number;
  duration_api_ms: number;
  total_cost_usd: number;
  tool_calls: string[];
}

function claude(
  prompt: string,
  mcpConfigPath: string = TEST_MCP_CONFIG,
  env: Record<string, string> = testEnv,
  cwd: string = ROOT,
): ClaudeResult {
  let raw: string;
  try {
    raw = execFileSync(
      "claude",
      [
        "-p",
        prompt,
        "--mcp-config",
        mcpConfigPath,
        "--output-format",
        "stream-json",
        "--max-turns",
        "15",
        "--no-session-persistence",
        "--permission-mode",
        "bypassPermissions",
        "--verbose",
        ...(E2E_MODEL ? ["--model", E2E_MODEL] : []),
      ],
      { cwd, timeout: 300_000, env, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 },
    ).toString();
  } catch (err) {
    // claude exits non-zero on e.g. max-turns — the stream output is still on
    // stdout, so keep parsing for diagnostics instead of losing everything.
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    if (!e.stdout?.length) {
      throw new Error(`claude CLI failed with no output. stderr: ${e.stderr?.toString().slice(0, 500)}`, { cause: err });
    }
    console.error(`[e2e] claude exited non-zero; parsing stream output anyway. stderr: ${e.stderr?.toString().slice(0, 300)}`);
    raw = e.stdout.toString();
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const events = lines.map((l) => JSON.parse(l));

  // Collect tool names from assistant messages with tool_use content blocks.
  // Separate broker tools from Claude Code internal tools (e.g. ToolSearch)
  // — internal tools are local tool resolution, not billed API turns.
  const allToolCalls: string[] = [];
  const toolCalls: string[] = [];
  let turnNum = 0;
  for (const event of events) {
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      turnNum++;
      for (const block of event.message.content) {
        if (block.type === "tool_use") {
          allToolCalls.push(block.name);
          // Log detailed tool call info for observability
          const inputSummary = block.input ? JSON.stringify(block.input) : "{}";
          console.error(`[e2e]   turn ${turnNum}: ${block.name}(${inputSummary})`);
          if (block.name.startsWith("mcp__broker__")) {
            toolCalls.push(block.name);
          }
        }
        if (block.type === "text" && block.text) {
          const textPreview = block.text.slice(0, 120).replace(/\n/g, " ");
          console.error(`[e2e]   turn ${turnNum}: [text] ${textPreview}`);
        }
      }
    }
  }

  // The last event should be the result
  const resultEvent = events.find((e) => e.type === "result");
  if (!resultEvent?.result) {
    const info = resultEvent?.subtype ?? resultEvent?.type ?? "unknown";
    throw new Error(`Claude returned no result (${info}): ${raw.slice(0, 500)}`);
  }

  console.error(
    `[e2e] done: turns=${resultEvent.num_turns} total=${resultEvent.duration_ms}ms ` +
    `api=${resultEvent.duration_api_ms}ms overhead=${resultEvent.duration_ms - resultEvent.duration_api_ms}ms ` +
    `cost=$${resultEvent.total_cost_usd} sequence=[${allToolCalls.join(" → ")}]`,
  );

  return { ...resultEvent, tool_calls: toolCalls };
}

describe.skipIf(!shouldRun)("E2E: Claude Code CLI", { timeout: 300_000 }, () => {
  beforeAll(() => {
    // 1. Build
    buildBroker(ROOT);

    // 2. Write MCP config that passes MCP_BROKER_HOME env to the broker server
    const mcpConfig = {
      mcpServers: {
        broker: {
          command: "node",
          args: [resolve(ROOT, "dist/index.js"), "serve"],
          env: { MCP_BROKER_HOME: TEST_DIR },
        },
      },
    };
    writeFileSync(TEST_MCP_CONFIG, JSON.stringify(mcpConfig, null, 2));

    // 3. Generate echo config with absolute path, seed the broker with it
    //    (uses MCP_BROKER_HOME via testEnv)
    writeEchoConfig(ROOT, ECHO_CONFIG_PATH);
    seedBroker(ROOT, ECHO_CONFIG_PATH, testEnv);

    return () => {
      try { rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
    };
  }, 120_000);

  it("discovers and calls an echo tool", () => {
    // Use a random nonce so the LLM can't answer without actually calling the tool
    const nonce = Math.random().toString(36).slice(2, 10);
    const response = claude(
      `Use the broker's echo tool to echo "nonce:${nonce}". You MUST use the broker MCP tools ` +
        "(mcp__broker__list_tools, mcp__broker__describe_tools, mcp__broker__call_tools) — do NOT use Bash or the shell echo command.",
    );

    // Exactly 3 broker tool calls: list → describe → call
    expect(response.tool_calls).toEqual([
      "mcp__broker__list_tools",
      "mcp__broker__describe_tools",
      "mcp__broker__call_tools",
    ]);
    // Random nonce proves the tool was actually called
    expect(response.result).toContain(nonce);
  });

  it("searches once, finds two tools, and calls both", () => {
    const nonce = Math.random().toString(36).slice(2, 10);
    const a = Math.floor(Math.random() * 100);
    const b = Math.floor(Math.random() * 100);

    const response = claude(
      `Using ONLY the broker MCP tools (mcp__broker__list_tools, mcp__broker__describe_tools, mcp__broker__call_tools — no Bash), ` +
        `find the echo server's tools, then in parallel, echo "nonce:${nonce}" AND add ${a} + ${b}. ` +
        "Batch both operations in a single call_tools invocation.",
    );

    // Exactly 3 broker tool calls: list → describe → call (batched with both invocations)
    expect(response.tool_calls).toEqual([
      "mcp__broker__list_tools",
      "mcp__broker__describe_tools",
      "mcp__broker__call_tools",
    ]);

    // Verify both results are present
    expect(response.result).toContain(`nonce:${nonce}`);
    expect(response.result).toContain(String(a + b));
  });

  it("adds a server and calls a tool on it", () => {
    const echoServerPath = resolve(ROOT, "tests/fixtures/echo-server.ts");

    const response = claude(
      `Using ONLY the broker MCP tools (no Bash), add an MCP server named "echo2" with command "npx" and args ["tsx", "${echoServerPath}"] ` +
        "via mcp__broker__add_mcp_server. Then use mcp__broker__list_tools, mcp__broker__describe_tools, and mcp__broker__call_tools to add 7 + 3 with its add tool.",
    );

    // Exactly 4 broker tool calls: add → list → describe → call
    expect(response.tool_calls).toEqual([
      "mcp__broker__add_mcp_server",
      "mcp__broker__list_tools",
      "mcp__broker__describe_tools",
      "mcp__broker__call_tools",
    ]);
    expect(response.result).toContain("10");
  });

  describe("cost comparison", () => {
    it("broker vs direct MCP (vibium browser)", () => {
      const prompt =
        "Using the vibium browser tools, navigate to https://example.com and tell me the page title. " +
        "You MUST use vibium browser tools (not WebFetch, Bash, or any other tool). " +
        "Call the tools directly yourself — do NOT spawn subagents or background tasks. Close the browser after.";

      // === Direct run (fully isolated — no broker config anywhere) ===
      const directDir = mkdtempSync(join(tmpdir(), "mcp-broker-e2e-direct-"));
      const directMcpConfig = join(directDir, "mcp.json");
      writeFileSync(directMcpConfig, JSON.stringify({
        mcpServers: { vibium: { command: "npx", args: ["-y", "vibium", "mcp"] } },
      }));
      const directEnv = { ...testEnv, MCP_BROKER_HOME: directDir };
      const directResult = claude(prompt, directMcpConfig, directEnv, directDir);
      expect(directResult.result).toContain("Example Domain");

      // === Broker run (isolated — fresh broker with vibium seeded) ===
      const brokerDir = mkdtempSync(join(tmpdir(), "mcp-broker-e2e-broker-"));
      const brokerEnv = { ...testEnv, MCP_BROKER_HOME: brokerDir };
      // Seed vibium into this broker instance
      const vibiumConfig = join(brokerDir, "vibium-config.json");
      writeFileSync(vibiumConfig, JSON.stringify({
        mcpServers: { vibium: { command: "npx", args: ["-y", "vibium", "mcp"] } },
      }));
      seedBroker(ROOT, vibiumConfig, brokerEnv, 120_000);
      const brokerMcpConfig = join(brokerDir, "mcp.json");
      writeFileSync(brokerMcpConfig, JSON.stringify({
        mcpServers: {
          broker: {
            command: "node",
            args: [resolve(ROOT, "dist/index.js"), "serve"],
            env: { MCP_BROKER_HOME: brokerDir },
          },
        },
      }));
      const brokerResult = claude(prompt, brokerMcpConfig, brokerEnv);
      expect(brokerResult.tool_calls).toContain("mcp__broker__list_tools");
      expect(brokerResult.tool_calls).toContain("mcp__broker__call_tools");
      expect(brokerResult.result).toContain("Example Domain");

      // Cleanup
      rmSync(directDir, { recursive: true, force: true });
      rmSync(brokerDir, { recursive: true, force: true });

      // No cost assertion here — this comparison is logged for information only.
      //
      // Why: Claude Code does not send MCP tool schemas to the model up front.
      // The model sees only a list of tool NAMES, and when it wants to use a
      // tool it first calls Claude Code's built-in ToolSearch, which loads the
      // full schemas for just the tools it picked. In other words, Claude Code
      // has its own built-in version of the broker's list → describe → call
      // pattern. So the "direct" run never pays the all-schemas-on-every-turn
      // cost that mcp-broker eliminates, and broker vs direct comes out about
      // equal (any difference is turn-count noise).
      //
      // The gemini e2e suite DOES assert broker < direct, because the gemini
      // CLI still sends every tool schema on every turn.
      const savings = ((1 - brokerResult.total_cost_usd / directResult.total_cost_usd) * 100).toFixed(1);
      console.error(
        `[e2e] cost comparison: broker=$${brokerResult.total_cost_usd.toFixed(4)} ` +
        `direct=$${directResult.total_cost_usd.toFixed(4)} savings=${savings}%`,
      );
    });
  });
});
