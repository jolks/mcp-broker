import { backupConfig, rewriteConfigForBroker, addBrokerToConfig } from "./client-config.js";

export interface ConfigCandidate {
  clientName: string;
  path: string;
  isSource: boolean;
}

export interface PromptIO {
  ask(question: string): Promise<string>;
  log(message: string): void;
}

export interface RewriteResult {
  configured: string[];
  errors: Array<{ name: string; error: string }>;
}

export function parseSelection(input: string, max: number): Set<number> | null {
  const trimmed = input.trim().toLowerCase();

  if (trimmed === "" || trimmed === "all") {
    return new Set(Array.from({ length: max }, (_, i) => i));
  }

  if (trimmed === "none") {
    return new Set();
  }

  const parts = trimmed.split(/[,\s]+/).filter(Boolean);
  const indices = new Set<number>();

  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 1 || num > max) {
      return null;
    }
    indices.add(num - 1);
  }

  return indices;
}

export async function promptAndRewriteConfigs(
  candidates: ConfigCandidate[],
  io: PromptIO,
): Promise<RewriteResult> {
  if (candidates.length === 0) {
    return { configured: [], errors: [] };
  }

  io.log("\nConfigure these AI tools to use mcp-broker:\n");
  for (let i = 0; i < candidates.length; i++) {
    const label = candidates[i].isSource ? " (source, will be rewritten)" : "";
    io.log(`  ${i + 1}. ${candidates[i].clientName} — ${candidates[i].path}${label}`);
  }

  let selected: Set<number> | null = null;
  while (selected === null) {
    const answer = await io.ask(`\nSelect [1-${candidates.length}, all, none] (default: all): `);
    selected = parseSelection(answer, candidates.length);
    if (selected === null) {
      io.log("Invalid selection. Enter numbers separated by commas, 'all', or 'none'.");
    }
  }

  const configured: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!selected.has(i)) {
      continue;
    }

    try {
      if (c.isSource) {
        backupConfig(c.path);
        rewriteConfigForBroker(c.path);
      } else {
        addBrokerToConfig(c.path);
      }
      configured.push(c.clientName);
    } catch (err) {
      errors.push({ name: c.clientName, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { configured, errors };
}
