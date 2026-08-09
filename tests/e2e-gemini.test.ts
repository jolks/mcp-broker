/**
 * E2E tests for mcp-broker using the Gemini CLI (`gemini -p`).
 *
 * Key differences from the Claude E2E suite (e2e-claude.test.ts):
 *
 * - **MCP config**: Gemini has no `--mcp-config` flag. It reads project-scoped
 *   config from `.gemini/settings.json` in the working directory. We create a
 *   temp dir with the config and pass it as `cwd`.
 * - **Permissions**: `-y` (yolo mode) instead of `--permission-mode bypassPermissions`.
 * - **No `--max-turns` or `--no-session-persistence`** flags available.
 * - **Tool name prefix**: Gemini uses `mcp_<server>_<tool>` (single underscore)
 *   vs Claude's `mcp__<server>__<tool>` (double underscore).
 * - **Stream-JSON format**: flat `tool_use` / `tool_result` / `message` events
 *   (no nested content blocks). Text streams in chunks that may split mid-word.
 * - **Result text**: the model may not repeat tool output values in its final
 *   text, so we include `tool_result` output in the collected result.
 * - **Token stats**: Gemini reports `total_tokens`, `input_tokens` (= cached +
 *   uncached), `cached`, `input` (uncached), `output_tokens`. No `total_cost_usd`.
 *
 * Findings from testing (2026-03-22):
 *
 * - **gemini-2.5-flash**: With vibium (85 MCP tools), broker achieved ~44% total
 *   token savings and ~70% uncached input savings. Flash's direct run uses more
 *   tokens for 85 tool schemas, making the broker's advantage larger. However,
 *   flash can be non-deterministic about batching sequential operations — it
 *   sometimes makes separate call_tools calls per step instead of batching with
 *   `sequential: true`, which adds overhead and may cause the test to fail.
 *
 * - **gemini-2.5-pro**: Nearly break-even on total tokens (~0.2% savings) but
 *   ~48% uncached input savings. Pro handles 85 tool schemas more efficiently
 *   in direct mode (27k vs flash's 45k total tokens), so the broker's total
 *   token advantage is smaller. Pro consistently follows the broker's batching
 *   instructions (single call_tools with sequential: true).
 *
 * - **Uncached tokens are the real cost metric**: both models show large uncached
 *   savings (48-70%) because the broker's 7 meta-tool schemas are much smaller
 *   than 85 vibium schemas, reducing the novel (non-cached) input per turn.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { writeFileSync, unlinkSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const shouldRun = process.env.RUN_E2E === "1";

const ECHO_CONFIG_PATH = resolve(ROOT, "tests/fixtures/echo-config.json");

// Use a temp directory so we don't touch ~/.mcp-broker
const TEST_DIR = mkdtempSync(join(tmpdir(), "mcp-broker-e2e-gemini-"));

// Build env: set MCP_BROKER_HOME for isolation
const testEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) {
    testEnv[k] = v;
  }
}
testEnv.MCP_BROKER_HOME = TEST_DIR;
// gemini CLI >= ~0.50 refuses to run headless from untrusted directories
// (exit 55); tests run from temp dirs, so trust the workspace explicitly.
testEnv.GEMINI_CLI_TRUST_WORKSPACE = "true";

interface GeminiResult {
  result: string;
  duration_ms: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  uncached_input_tokens: number;
  tool_calls: string[];
  tool_calls_per_turn: string[][];
}

/**
 * Gemini CLI uses project-scoped MCP config from `.gemini/settings.json` in the cwd.
 * We create a temp directory with the config and run gemini from there.
 */
function gemini(
  prompt: string,
  cwd: string,
  env: Record<string, string> = testEnv,
): GeminiResult {
  let raw: string;
  try {
    raw = execFileSync(
      "gemini",
      [
        "-p",
        prompt,
        "-m",
        "gemini-2.5-flash",
        "-o",
        "stream-json",
        "-y",
      ],
      { cwd, timeout: 300_000, env, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 },
    ).toString();
  } catch (err) {
    // On timeout/non-zero exit, keep whatever streamed to stdout so the
    // failure shows which tools ran instead of a bare "Command failed".
    const e = err as { stdout?: Buffer; stderr?: Buffer; code?: string };
    console.error(
      `[e2e-gemini] gemini CLI failed (${e.code ?? "non-zero exit"}). ` +
      `stderr: ${e.stderr?.toString().slice(0, 300)}`,
    );
    if (!e.stdout?.length) {
      throw new Error(`gemini CLI failed with no output. stderr: ${e.stderr?.toString().slice(0, 500)}`, { cause: err });
    }
    raw = e.stdout.toString();
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const events = lines.map((l) => JSON.parse(l));

  // Collect tool names from tool_use events.
  // Broker tools are prefixed with mcp_broker_
  const allToolCalls: string[] = [];
  const toolCalls: string[] = [];
  const toolCallsPerTurn: string[][] = [];
  // Gemini emits flat tool_use events, group consecutive ones as a "turn"
  let currentTurnTools: string[] = [];
  let lastEventWasToolUse = false;

  for (const event of events) {
    if (event.type === "tool_use") {
      const toolName = event.tool_name as string;
      allToolCalls.push(toolName);
      const paramsSummary = event.parameters ? JSON.stringify(event.parameters) : "{}";
      console.error(`[e2e-gemini]   tool_use: ${toolName}(${paramsSummary})`);
      if (toolName.startsWith("mcp_broker_")) {
        toolCalls.push(toolName);
        currentTurnTools.push(toolName);
      }
      lastEventWasToolUse = true;
    } else {
      if (lastEventWasToolUse && currentTurnTools.length > 0) {
        toolCallsPerTurn.push(currentTurnTools);
        currentTurnTools = [];
      }
      lastEventWasToolUse = false;
    }

    if (event.type === "message" && event.role === "assistant" && event.content) {
      const textPreview = String(event.content).slice(0, 120).replace(/\n/g, " ");
      console.error(`[e2e-gemini]   assistant: ${textPreview}`);
    }
  }
  // Flush any remaining turn tools
  if (currentTurnTools.length > 0) {
    toolCallsPerTurn.push(currentTurnTools);
  }

  // The last event should be the result
  const resultEvent = events.find((e) => e.type === "result");
  if (!resultEvent || resultEvent.status !== "success") {
    throw new Error(`Gemini returned no success result: ${raw.slice(0, 500)}`);
  }

  // Collect assistant text and tool results.
  // Gemini streams text in chunks that may split mid-word, so join without
  // separator and collapse whitespace for reliable substring matching.
  // Include tool_result output because the model may not repeat values in its
  // final text response.
  const resultText = events
    .filter((e) =>
      (e.type === "message" && e.role === "assistant" && e.content) ||
      (e.type === "tool_result" && e.output))
    .map((e) => e.type === "tool_result" ? String(e.output) : String(e.content))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  const stats = resultEvent.stats ?? {};
  const cached = stats.cached ?? 0;
  const uncachedInput = stats.input ?? stats.input_tokens ?? 0;
  console.error(
    `[e2e-gemini] done: tokens=${stats.total_tokens} input=${stats.input_tokens} ` +
    `(cached=${cached} uncached=${uncachedInput}) ` +
    `output=${stats.output_tokens} duration=${stats.duration_ms}ms ` +
    `tool_calls=${allToolCalls.length} sequence=[${allToolCalls.join(" → ")}]`,
  );

  return {
    result: resultText,
    duration_ms: stats.duration_ms ?? 0,
    total_tokens: stats.total_tokens ?? 0,
    input_tokens: stats.input_tokens ?? 0,
    output_tokens: stats.output_tokens ?? 0,
    cached_tokens: cached,
    uncached_input_tokens: uncachedInput,
    tool_calls: toolCalls,
    tool_calls_per_turn: toolCallsPerTurn,
  };
}

/**
 * Write Gemini project-scoped MCP config into `<dir>/.gemini/settings.json`.
 */
function writeGeminiMcpConfig(dir: string, mcpServers: Record<string, unknown>): void {
  const geminiDir = join(dir, ".gemini");
  mkdirSync(geminiDir, { recursive: true });
  writeFileSync(join(geminiDir, "settings.json"), JSON.stringify({ mcpServers }, null, 2));
}

describe.skipIf(!shouldRun)("E2E: Gemini CLI", { timeout: 300_000 }, () => {
  // Each test gets its own working directory with a .gemini/settings.json
  // that points to the broker server (which in turn uses TEST_DIR for MCP_BROKER_HOME).
  const testCwd = join(TEST_DIR, "workdir");

  beforeAll(() => {
    // 1. Build
    execFileSync("pnpm", ["run", "build"], { cwd: ROOT, timeout: 60_000, stdio: "pipe" });

    // 2. Create working directory
    mkdirSync(testCwd, { recursive: true });

    // 3. Write Gemini MCP config pointing to the broker
    writeGeminiMcpConfig(testCwd, {
      broker: {
        command: "node",
        args: [resolve(ROOT, "dist/index.js"), "serve"],
        env: { MCP_BROKER_HOME: TEST_DIR },
      },
    });

    // 4. Generate echo-config.json with absolute path
    const echoServerPath = resolve(ROOT, "tests/fixtures/echo-server.ts");
    const config = {
      mcpServers: {
        echo: {
          command: "npx",
          args: ["tsx", echoServerPath],
        },
      },
    };
    writeFileSync(ECHO_CONFIG_PATH, JSON.stringify(config, null, 2));

    // 5. Seed the broker with echo server
    execFileSync(
      "node",
      ["dist/index.js", "setup", ECHO_CONFIG_PATH, "--no-rewrite"],
      { cwd: ROOT, timeout: 60_000, stdio: "pipe", env: testEnv },
    );

    return () => {
      try { unlinkSync(ECHO_CONFIG_PATH); } catch { /* ignore */ }
      try { rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
    };
  }, 120_000);

  it("discovers and calls an echo tool", () => {
    const nonce = Math.random().toString(36).slice(2, 10);
    const response = gemini(
      `Use the broker's list_tools to find echo tools, describe_tools to get their schemas, then call_tools to echo "nonce:${nonce}". You MUST use broker tools (mcp_broker_list_tools, mcp_broker_describe_tools, then mcp_broker_call_tools).`,
      testCwd,
    );

    // Exactly 3 broker tool calls: list → describe → call
    expect(response.tool_calls).toEqual([
      "mcp_broker_list_tools",
      "mcp_broker_describe_tools",
      "mcp_broker_call_tools",
    ]);
    // Random nonce proves the tool was actually called
    expect(response.result).toContain(nonce);
  });

  it("searches once, finds two tools, and calls both", () => {
    const nonce = Math.random().toString(36).slice(2, 10);
    const a = Math.floor(Math.random() * 100);
    const b = Math.floor(Math.random() * 100);

    const response = gemini(
      `Use broker list_tools to find echo tools, describe_tools to get their schemas (batch both tools in one describe_tools call), then broker call_tools to do BOTH: echo "nonce:${nonce}" AND add ${a} + ${b}. Batch both in a single call_tools invocation.`,
      testCwd,
    );

    // Exactly 3 broker tool calls: list → describe → call (batched with both invocations)
    expect(response.tool_calls).toEqual([
      "mcp_broker_list_tools",
      "mcp_broker_describe_tools",
      "mcp_broker_call_tools",
    ]);

    // Verify both results are present
    expect(response.result).toContain(`nonce:${nonce}`);
    expect(response.result).toContain(String(a + b));
  });

  it("adds a server and calls a tool on it", () => {
    const echoServerPath = resolve(ROOT, "tests/fixtures/echo-server.ts");

    const response = gemini(
      `Use the broker tools to add an MCP server named "echo2" with command "npx" and args ["tsx", "${echoServerPath}"]. ` +
        "Then use list_tools to find its add tool, describe_tools for its schema, and call_tools to add 7 + 3.",
      testCwd,
    );

    // Exactly 4 broker tool calls: add → list → describe → call
    expect(response.tool_calls).toEqual([
      "mcp_broker_add_mcp_server",
      "mcp_broker_list_tools",
      "mcp_broker_describe_tools",
      "mcp_broker_call_tools",
    ]);
    expect(response.result).toContain("10");
  });

  describe("cost comparison", () => {
    it("broker vs direct MCP (vibium browser)", () => {
      const prompt =
        "Using the vibium browser tools, navigate to https://example.com and tell me the page title. " +
        "You MUST use vibium browser tools (not any built-in web fetch tool). Close the browser after.";

      // === Direct run (fully isolated — no broker config anywhere) ===
      const directDir = mkdtempSync(join(tmpdir(), "mcp-broker-e2e-gemini-direct-"));
      const directCwd = join(directDir, "workdir");
      mkdirSync(directCwd, { recursive: true });
      writeGeminiMcpConfig(directCwd, {
        vibium: { command: "npx", args: ["-y", "vibium", "mcp"] },
      });
      const directEnv = { ...testEnv, MCP_BROKER_HOME: directDir };
      const directResult = gemini(prompt, directCwd, directEnv);
      expect(directResult.result).toContain("Example Domain");

      // === Broker run (isolated — fresh broker with vibium seeded) ===
      const brokerDir = mkdtempSync(join(tmpdir(), "mcp-broker-e2e-gemini-broker-"));
      const brokerCwd = join(brokerDir, "workdir");
      mkdirSync(brokerCwd, { recursive: true });
      const brokerEnv = { ...testEnv, MCP_BROKER_HOME: brokerDir };
      // Seed vibium into this broker instance
      const vibiumConfig = join(brokerDir, "vibium-config.json");
      writeFileSync(vibiumConfig, JSON.stringify({
        mcpServers: { vibium: { command: "npx", args: ["-y", "vibium", "mcp"] } },
      }));
      execFileSync(
        "node",
        ["dist/index.js", "setup", vibiumConfig, "--no-rewrite"],
        { cwd: ROOT, timeout: 120_000, stdio: "pipe", env: brokerEnv },
      );
      writeGeminiMcpConfig(brokerCwd, {
        broker: {
          command: "node",
          args: [resolve(ROOT, "dist/index.js"), "serve"],
          env: { MCP_BROKER_HOME: brokerDir },
        },
      });
      const brokerResult = gemini(prompt, brokerCwd, brokerEnv);
      expect(brokerResult.tool_calls).toContain("mcp_broker_list_tools");
      expect(brokerResult.tool_calls).toContain("mcp_broker_call_tools");
      expect(brokerResult.result).toContain("Example Domain");

      // Cleanup
      rmSync(directDir, { recursive: true, force: true });
      rmSync(brokerDir, { recursive: true, force: true });

      // Token comparison is logged for information only (Gemini doesn't report
      // cost in USD) — no assertion, deliberately.
      //
      // Why: measured 2026-07 on this 85-tool benchmark, the broker uses ~8-13%
      // MORE tokens than direct. Two things changed since the original ~70%
      // savings measurement: (1) gemini now caches the direct-mode schema block
      // near-perfectly after turn 1, so the per-turn schema resend the broker
      // eliminates is already cache-discounted; (2) the broker's discovery adds
      // turns (describe_tools step + gemini's update_topic churn), and each
      // turn costs ~13k tokens of gemini CLI baseline context — more than the
      // schema savings at this registry size. The broker still wins on much
      // larger registries (with server_names-filtered list_tools) and on
      // clients that don't cache schemas; this benchmark is neither.
      const tokenSavings = ((1 - brokerResult.total_tokens / directResult.total_tokens) * 100).toFixed(1);
      const uncachedSavings = ((1 - brokerResult.uncached_input_tokens / directResult.uncached_input_tokens) * 100).toFixed(1);
      console.error(
        `[e2e-gemini] token comparison:\n` +
        `  direct:  total=${directResult.total_tokens} input=${directResult.input_tokens} ` +
        `(cached=${directResult.cached_tokens} uncached=${directResult.uncached_input_tokens}) ` +
        `output=${directResult.output_tokens}\n` +
        `  broker:  total=${brokerResult.total_tokens} input=${brokerResult.input_tokens} ` +
        `(cached=${brokerResult.cached_tokens} uncached=${brokerResult.uncached_input_tokens}) ` +
        `output=${brokerResult.output_tokens}\n` +
        `  total_savings=${tokenSavings}% uncached_savings=${uncachedSavings}%`,
      );
    });
  });
});
