const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVEL_ORDER;

let minLevel: Level = "info";

export function setLogLevel(level: Level): void {
  minLevel = level;
}

function log(level: Level, msg: string, ...args: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (args.length > 0) {
    process.stderr.write(`${prefix} ${msg} ${args.map(a => JSON.stringify(a)).join(" ")}\n`);
  } else {
    process.stderr.write(`${prefix} ${msg}\n`);
  }
}

export const logger = {
  debug: (msg: string, ...args: unknown[]) => log("debug", msg, ...args),
  info: (msg: string, ...args: unknown[]) => log("info", msg, ...args),
  warn: (msg: string, ...args: unknown[]) => log("warn", msg, ...args),
  error: (msg: string, ...args: unknown[]) => log("error", msg, ...args),
};
