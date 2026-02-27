import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger, setLogLevel } from "../src/logger.js";

describe("logger", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // Reset to default level
    setLogLevel("info");
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // ── Level filtering ─────────────────────────────────

  describe("level filtering", () => {
    it("debug is hidden at info level", () => {
      logger.debug("hidden message");
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("info is shown at info level", () => {
      logger.info("visible message");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy.mock.calls[0][0]).toContain("visible message");
    });

    it("warn is shown at info level", () => {
      logger.warn("warning message");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });

    it("error is shown at info level", () => {
      logger.error("error message");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });

    it("debug is shown at debug level", () => {
      setLogLevel("debug");
      logger.debug("debug message");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy.mock.calls[0][0]).toContain("debug message");
    });

    it("info is hidden at warn level", () => {
      setLogLevel("warn");
      logger.info("hidden");
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("warn is shown at warn level", () => {
      setLogLevel("warn");
      logger.warn("visible");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });

    it("error level hides warn", () => {
      setLogLevel("error");
      logger.warn("hidden");
      expect(stderrSpy).not.toHaveBeenCalled();
      logger.error("visible");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── Formatting ──────────────────────────────────────

  describe("formatting", () => {
    it("includes timestamp in ISO format", () => {
      logger.info("test");
      const output = stderrSpy.mock.calls[0][0] as string;
      // ISO timestamp pattern: [2024-01-01T00:00:00.000Z]
      expect(output).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("includes level prefix in uppercase", () => {
      logger.info("test");
      expect(stderrSpy.mock.calls[0][0]).toContain("[INFO]");
    });

    it("includes the message", () => {
      logger.info("hello world");
      expect(stderrSpy.mock.calls[0][0]).toContain("hello world");
    });

    it("ends with newline", () => {
      logger.info("test");
      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output.endsWith("\n")).toBe(true);
    });

    it("includes additional args as JSON", () => {
      logger.info("msg", { key: "value" }, 42);
      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toContain('{"key":"value"}');
      expect(output).toContain("42");
    });

    it("formats each level correctly", () => {
      setLogLevel("debug");
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");

      expect(stderrSpy.mock.calls[0][0]).toContain("[DEBUG]");
      expect(stderrSpy.mock.calls[1][0]).toContain("[INFO]");
      expect(stderrSpy.mock.calls[2][0]).toContain("[WARN]");
      expect(stderrSpy.mock.calls[3][0]).toContain("[ERROR]");
    });
  });

  // ── setLogLevel ─────────────────────────────────────

  describe("setLogLevel", () => {
    it("changes the minimum log level", () => {
      setLogLevel("debug");
      logger.debug("visible");
      expect(stderrSpy).toHaveBeenCalledTimes(1);

      stderrSpy.mockClear();
      setLogLevel("error");
      logger.debug("hidden");
      logger.info("hidden");
      logger.warn("hidden");
      expect(stderrSpy).not.toHaveBeenCalled();

      logger.error("visible");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });
  });
});
