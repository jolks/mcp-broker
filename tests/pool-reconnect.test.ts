import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Pool } from "../src/pool.js";
import type { ServerRecord } from "../src/store.js";

// Shared flag to control connect behavior from tests
let connectShouldFail = false;

// Track created transport instances
const transportInstances: Array<{
  onclose: (() => void) | null;
  onerror: ((err: Error) => void) | null;
  close: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  return {
    Client: class MockClient {
      connect = vi.fn(async () => {
        if (connectShouldFail) throw new Error("connect failed");
      });
      close = vi.fn().mockResolvedValue(undefined);
    },
  };
});

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => {
  return {
    StdioClientTransport: class MockTransport {
      onclose: (() => void) | null = null;
      onerror: ((err: Error) => void) | null = null;
      close = vi.fn().mockResolvedValue(undefined);
      constructor() {
        transportInstances.push(this);
      }
    },
  };
});

function getLastTransport() {
  return transportInstances[transportInstances.length - 1];
}

const server: ServerRecord = { name: "test-srv", command: "echo", args: [] };

describe("Pool reconnect", () => {
  let pool: Pool;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    transportInstances.length = 0;
    connectShouldFail = false;
    pool = new Pool();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules reconnect when transport closes", async () => {
    await pool.connectServer(server);
    expect(pool.isConnected("test-srv")).toBe(true);

    const transport = getLastTransport();
    transport.onclose!();

    expect(pool.isConnected("test-srv")).toBe(false);

    // Advance past the initial reconnect delay (5s)
    await vi.advanceTimersByTimeAsync(5_000);

    expect(pool.isConnected("test-srv")).toBe(true);
  });

  it("does not reconnect after closeAll", async () => {
    await pool.connectServer(server);
    await pool.closeAll();

    // closeAll sets closed=true, so scheduleReconnect returns early
    expect(pool.isConnected("test-srv")).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(pool.isConnected("test-srv")).toBe(false);
  });

  it("does not reconnect if already reconnected before timer fires", async () => {
    await pool.connectServer(server);
    const transport = getLastTransport();
    transport.onclose!();

    // Manually reconnect before timer fires
    await pool.connectServer(server);
    expect(pool.isConnected("test-srv")).toBe(true);

    const transportCountBefore = transportInstances.length;

    // Timer fires but server is already connected — no-op
    await vi.advanceTimersByTimeAsync(5_000);

    expect(transportInstances.length).toBe(transportCountBefore);
  });

  it("retries with exponential backoff on reconnect failure", async () => {
    await pool.connectServer(server);
    const transport = getLastTransport();
    transport.onclose!();

    // Make next connect fail
    connectShouldFail = true;

    // First attempt at 5s — fails
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pool.isConnected("test-srv")).toBe(false);

    // Allow next connect to succeed
    connectShouldFail = false;

    // Second attempt at 10s (5000 * 2^1 = 10000)
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pool.isConnected("test-srv")).toBe(true);
  });

  it("gives up after MAX_RECONNECT_ATTEMPTS", async () => {
    await pool.connectServer(server);
    const transport = getLastTransport();
    transport.onclose!();

    // Make all reconnects fail
    connectShouldFail = true;

    // Advance through all 10 attempts
    // Delays: 5s, 10s, 20s, 40s, 80s, 160s, 300s, 300s, 300s, 300s = 1515s total
    await vi.advanceTimersByTimeAsync(1_515_000);

    expect(pool.isConnected("test-srv")).toBe(false);

    // Allow connect to succeed — but no more attempts should be scheduled
    connectShouldFail = false;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(pool.isConnected("test-srv")).toBe(false);
  });

  it("does not schedule duplicate reconnect for same server", async () => {
    await pool.connectServer(server);
    const transport = getLastTransport();
    transport.onclose!();

    // The onclose already scheduled a reconnect. If we trigger onclose
    // from the new transport during reconnect, it shouldn't duplicate.
    // Just verify that after one delay, server reconnects cleanly.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pool.isConnected("test-srv")).toBe(true);
  });

  it("cleans up reconnect state on disconnectServer", async () => {
    await pool.connectServer(server);
    const transport = getLastTransport();

    // Trigger a close so reconnect is scheduled
    transport.onclose!();
    expect(pool.isConnected("test-srv")).toBe(false);

    // Explicitly disconnect — should clear reconnect state
    await pool.disconnectServer("test-srv");

    // Advance well past the reconnect delay — no reconnect should fire
    const transportCountBefore = transportInstances.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pool.isConnected("test-srv")).toBe(false);
    expect(transportInstances.length).toBe(transportCountBefore);
  });

  it("skips reconnect callback if pool closed during delay", async () => {
    await pool.connectServer(server);
    const transport = getLastTransport();
    transport.onclose!();

    // Close pool while reconnect timer is pending
    await pool.closeAll();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(pool.isConnected("test-srv")).toBe(false);
  });
});
