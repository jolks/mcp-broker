import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { harvestTools } from "../src/harvester.js";

const FIXTURE = resolve(import.meta.dirname, "fixtures/echo-server.ts");

describe("harvestTools (integration)", { timeout: 30_000 }, () => {
  it("discovers tools from echo-server", async () => {
    const tools = await harvestTools("npx", ["tsx", FIXTURE]);

    expect(tools).toHaveLength(2);

    const names = tools.map((t) => t.tool_name).sort();
    expect(names).toEqual(["add", "echo"]);
  });

  it("returns correct tool_name and description", async () => {
    const tools = await harvestTools("npx", ["tsx", FIXTURE]);

    const echo = tools.find((t) => t.tool_name === "echo")!;
    expect(echo.description).toBe("Returns the input message as-is");

    const add = tools.find((t) => t.tool_name === "add")!;
    expect(add.description).toBe("Returns the sum of two numbers");
  });

  it("returns input_schema as JSON string", async () => {
    const tools = await harvestTools("npx", ["tsx", FIXTURE]);

    const echo = tools.find((t) => t.tool_name === "echo")!;
    const schema = JSON.parse(echo.input_schema);
    expect(schema.type).toBe("object");
    expect(schema.properties.message).toBeDefined();
    expect(schema.required).toEqual(["message"]);
  });

  it("throws for non-existent command", async () => {
    await expect(
      harvestTools("__nonexistent_command_abc123__", [])
    ).rejects.toThrow();
  });
});
