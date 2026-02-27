import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import { brokerHome, dbPath, registryPath, backupsDir, buildEnv, raceTimeout } from "../src/config.js";

describe("config", () => {
  const originalEnv = process.env.MCP_BROKER_HOME;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MCP_BROKER_HOME;
    } else {
      process.env.MCP_BROKER_HOME = originalEnv;
    }
  });

  // ── brokerHome ──────────────────────────────────────

  describe("brokerHome", () => {
    it("returns MCP_BROKER_HOME when set", () => {
      process.env.MCP_BROKER_HOME = "/tmp/custom";
      expect(brokerHome()).toBe("/tmp/custom");
    });

    it("defaults to ~/.mcp-broker when env is not set", () => {
      delete process.env.MCP_BROKER_HOME;
      expect(brokerHome()).toBe(join(homedir(), ".mcp-broker"));
    });
  });

  // ── path helpers ─────────────────────────────────────

  describe("path helpers", () => {
    beforeEach(() => {
      process.env.MCP_BROKER_HOME = "/tmp/test-broker";
    });

    it("dbPath returns broker.db inside brokerHome", () => {
      expect(dbPath()).toBe("/tmp/test-broker/broker.db");
    });

    it("registryPath returns servers.json inside brokerHome", () => {
      expect(registryPath()).toBe("/tmp/test-broker/servers.json");
    });

    it("backupsDir returns backups/ inside brokerHome", () => {
      expect(backupsDir()).toBe("/tmp/test-broker/backups");
    });
  });

  // ── buildEnv ─────────────────────────────────────────

  describe("buildEnv", () => {
    it("returns undefined when no env provided", () => {
      expect(buildEnv()).toBeUndefined();
      expect(buildEnv(undefined)).toBeUndefined();
    });

    it("merges env with process.env", () => {
      const result = buildEnv({ MY_VAR: "hello" });
      expect(result).toBeDefined();
      expect(result!.MY_VAR).toBe("hello");
      expect(result!.PATH).toBe(process.env.PATH);
    });

    it("overrides process.env with provided vars", () => {
      const result = buildEnv({ PATH: "/custom/path" });
      expect(result!.PATH).toBe("/custom/path");
    });
  });

  // ── raceTimeout ──────────────────────────────────────

  describe("raceTimeout", () => {
    it("resolves when promise resolves before timeout", async () => {
      const result = await raceTimeout(
        Promise.resolve("ok"),
        1000,
        "timed out"
      );
      expect(result).toBe("ok");
    });

    it("rejects with timeout message when promise is too slow", async () => {
      const slow = new Promise((resolve) => setTimeout(resolve, 5000));
      await expect(
        raceTimeout(slow, 10, "custom timeout message")
      ).rejects.toThrow("custom timeout message");
    });

    it("propagates promise rejection", async () => {
      await expect(
        raceTimeout(Promise.reject(new Error("boom")), 1000, "timeout")
      ).rejects.toThrow("boom");
    });
  });
});
