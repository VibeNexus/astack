/**
 * Minimal JSON logger.
 *
 * Design goals (single-user local daemon):
 *   - Human-skimmable in `tail -f ~/.astack/daemon.log`
 *   - Structured enough to grep by event key
 *   - Zero dependencies (avoid pulling pino/winston for a personal tool)
 *
 * Output format:  ISO8601 LEVEL event key1=val1 key2=val2
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

function format(level: LogLevel, event: string, fields?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const head = `${ts} ${level.toUpperCase().padEnd(5)} ${event}`;
  if (!fields) return head;

  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${s}`);
  }
  return parts.length > 0 ? `${head} ${parts.join(" ")}` : head;
}

/**
 * Create a logger writing to the given stream (or streams).
 *
 * Stderr is the right choice for daemon logs — stdout is reserved for
 * structured output (e.g. `astack-server status --json`).
 *
 * v0.6: accepts an array of streams so the daemon can tee `process.stderr`
 * and a `fs.createWriteStream(config.logFile, {flags:'a'})` in one logger
 * instance without a separate decorator function.
 */
export function createLogger(
  minLevel: LogLevel = "info",
  stream:
    | NodeJS.WritableStream
    | NodeJS.WritableStream[] = process.stderr
): Logger {
  const min = LEVEL_ORDER[minLevel];
  const streams = Array.isArray(stream) ? stream : [stream];

  function log(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < min) return;
    const line = format(level, event, fields) + "\n";
    for (const s of streams) {
      s.write(line);
    }
  }

  return {
    debug: (e, f) => log("debug", e, f),
    info: (e, f) => log("info", e, f),
    warn: (e, f) => log("warn", e, f),
    error: (e, f) => log("error", e, f)
  };
}

/** No-op logger for tests that don't care about output. */
export function nullLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  };
}
