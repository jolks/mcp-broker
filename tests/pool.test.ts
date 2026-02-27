import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { Pool } from "../src/pool.js";
import type { ServerRecord } from "../src/store.js";

const FIXTURE = resolve(import.meta.dirname, "fixtures/echo-server.ts");

function echoServer(name = "echo"): ServerRecord {
  return {
    name,
    command: "npx",
    args: ["tsx", FIXTURE],
    env: undefined,
  };
}

describe("Pool (integration)", { timeout: 30_000 }, () => {
  let pool: Pool;

  afterEach(async () => {
    await pool?.closeAll();
  });

  // ── connectServer ───────────────────────────────────

  describe("connectServer", () => {
    it("connects to echo-server and returns client", async () => {
      pool = new Pool();
      const client = await pool.connectServer(echoServer());

      expect(client).toBeDefined();
      expect(pool.isConnected("echo")).toBe(true);
    });

    it("returns existing client on duplicate connect", async () => {
      pool = new Pool();
      const client1 = await pool.connectServer(echoServer());
      const client2 = await pool.connectServer(echoServer());

      expect(client1).toBe(client2);
    });

    it("throws for non-existent command", async () => {
      pool = new Pool();
      const bad: ServerRecord = {
        name: "bad",
        command: "__nonexistent_command_abc123__",
        args: [],
      };
      await expect(pool.connectServer(bad)).rejects.toThrow();
    });
  });

  // ── getClient / isConnected ──────────────────────────

  describe("getClient / isConnected", () => {
    it("getClient returns client after connect", async () => {
      pool = new Pool();
      await pool.connectServer(echoServer());

      const client = pool.getClient("echo");
      expect(client).toBeDefined();
    });

    it("getClient returns undefined for unknown server", () => {
      pool = new Pool();
      expect(pool.getClient("nope")).toBeUndefined();
    });

    it("isConnected returns false for unknown server", () => {
      pool = new Pool();
      expect(pool.isConnected("nope")).toBe(false);
    });
  });

  // ── calling tools through pool client ───────────────

  describe("calling tools via pool client", () => {
    it("calls echo tool and gets result", async () => {
      pool = new Pool();
      await pool.connectServer(echoServer());
      const client = pool.getClient("echo")!;

      const result = await client.callTool({
        name: "echo",
        arguments: { message: "hello" },
      });

      expect(result.content).toEqual([
        { type: "text", text: "Echo: hello" },
      ]);
    });

    it("calls add tool and gets result", async () => {
      pool = new Pool();
      await pool.connectServer(echoServer());
      const client = pool.getClient("echo")!;

      const result = await client.callTool({
        name: "add",
        arguments: { a: 3, b: 7 },
      });

      expect(result.content).toEqual([
        { type: "text", text: "10" },
      ]);
    });
  });

  // ── disconnectServer ────────────────────────────────

  describe("disconnectServer", () => {
    it("disconnects a connected server", async () => {
      pool = new Pool();
      await pool.connectServer(echoServer());
      expect(pool.isConnected("echo")).toBe(true);

      await pool.disconnectServer("echo");
      expect(pool.isConnected("echo")).toBe(false);
      expect(pool.getClient("echo")).toBeUndefined();
    });

    it("is a no-op for unknown server", async () => {
      pool = new Pool();
      await pool.disconnectServer("nope"); // should not throw
    });
  });

  // ── connectAll / closeAll ───────────────────────────

  describe("connectAll / closeAll", () => {
    it("connectAll connects multiple servers", async () => {
      pool = new Pool();
      await pool.connectAll([echoServer("x"), echoServer("y")]);

      expect(pool.isConnected("x")).toBe(true);
      expect(pool.isConnected("y")).toBe(true);
    });

    it("connectAll does not throw if one server fails", async () => {
      pool = new Pool();
      const bad: ServerRecord = {
        name: "bad",
        command: "__nonexistent__",
        args: [],
      };
      // Should not throw even though "bad" will fail
      await pool.connectAll([echoServer("good"), bad]);
      expect(pool.isConnected("good")).toBe(true);
      expect(pool.isConnected("bad")).toBe(false);
    });

    it("closeAll disconnects all servers", async () => {
      pool = new Pool();
      await pool.connectAll([echoServer("a"), echoServer("b")]);
      expect(pool.isConnected("a")).toBe(true);
      expect(pool.isConnected("b")).toBe(true);

      await pool.closeAll();
      expect(pool.isConnected("a")).toBe(false);
      expect(pool.isConnected("b")).toBe(false);
    });
  });
});
