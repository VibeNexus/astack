#!/usr/bin/env node
/**
 * @astack/server — CLI entry point for the daemon.
 *
 * Subcommands (design.md § Eng Review decision 4):
 *   astack-server start    — start daemon on 127.0.0.1:7432 (foreground)
 *   astack-server stop     — SIGTERM running daemon
 *   astack-server status   — print running state + pid + port
 *   astack-server logs     — tail daemon.log
 *
 * Exit codes:
 *   0  success / daemon running
 *   1  error
 *   2  not running (for status)
 *
 * Before doing any real work we hard-check the Node.js version: node:sqlite
 * (added in 22.5, unflagged in 22.13) is a required runtime dependency since
 * v0.2. Running on older Node would surface an obscure import failure; we
 * want a friendly message instead.
 */

import fs from "node:fs";

import { AstackError, ErrorCode } from "@astack/shared";

import { loadConfig, type ServerConfig } from "./config.js";
import {
  installSignalHandlers,
  isPortInUse,
  isProcessAlive,
  readPidFile,
  startDaemon,
  stopDaemon
} from "./daemon.js";
import { createLogger } from "./logger.js";

/**
 * Parse a node version string like `v22.13.0` or `24.14.1`. Exported
 * for unit tests.
 */
export function parseNodeVersion(raw: string): {
  ok: boolean;
  parsed: { major: number; minor: number; patch: number };
} {
  const m = raw.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  const parsed = {
    major: m ? parseInt(m[1]!, 10) : 0,
    minor: m ? parseInt(m[2]!, 10) : 0,
    patch: m ? parseInt(m[3]!, 10) : 0
  };
  if (!m) return { ok: false, parsed };
  const { major, minor } = parsed;
  // >= 22.13 OR any major >= 23
  const ok = major > 22 || (major === 22 && minor >= 13);
  return { ok, parsed };
}

/**
 * Refuse to run on Node < 22.13. Exported for testability.
 * Called at the top of main(); tests can invoke it directly with
 * injected args.
 */
export function checkNodeVersion(
  raw: string = process.versions.node,
  exit: (code: number) => never = process.exit.bind(process) as (c: number) => never,
  write: (msg: string) => void = (m) => process.stderr.write(m)
): void {
  const { ok, parsed } = parseNodeVersion(raw);
  if (ok) return;
  write(
    [
      `astack-server requires Node.js >= 22.13.0 (node:sqlite not available below).`,
      `Current: ${raw} (parsed as ${parsed.major}.${parsed.minor}.${parsed.patch}).`,
      `Upgrade: https://nodejs.org/ or use nvm / fnm to switch.`,
      ""
    ].join("\n")
  );
  exit(1);
}


async function main(): Promise<void> {
  checkNodeVersion();
  const [, , command = "start", ...rest] = process.argv;
  const config = loadConfig();

  switch (command) {
    case "start":
      await cmdStart(config);
      break;
    case "stop":
      cmdStop(config);
      break;
    case "status":
      await cmdStatus(config);
      break;
    case "logs":
      cmdLogs(config, rest);
      break;
    case "--help":
    case "-h":
    case "help":
      printUsage();
      break;
    default:
      process.stderr.write(`unknown subcommand: ${command}\n`);
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: astack-server <command>",
      "",
      "Commands:",
      "  start      Run the daemon in the foreground",
      "  stop       SIGTERM the running daemon (pid from ~/.astack/daemon.pid)",
      "  status     Print daemon state (running / not running) and exit",
      "  logs       Tail the daemon log (pass --lines N for head size)",
      "  help       Show this message",
      ""
    ].join("\n")
  );
}

async function cmdStart(config: ServerConfig): Promise<void> {
  const logger = createLogger("info");
  // Respected by E2E harness (packages/web/e2e/fixtures/start-server.mjs) to
  // prevent real git clones of BUILTIN_SEEDS during smoke tests. Unset in
  // production — users want the seeded repos.
  const seedsDisabled = process.env.ASTACK_DISABLE_SEEDS === "1";
  try {
    const handle = await startDaemon(config, logger, { seeds: !seedsDisabled });
    installSignalHandlers(handle, logger);
    process.stdout.write(
      `astack-server listening on http://${config.host}:${config.port}\n`
    );
    // Keep the process alive; serve() already holds the event loop open via
    // the TCP server. Nothing more to do here.
  } catch (err) {
    if (err instanceof AstackError && err.code === ErrorCode.SERVER_ALREADY_RUNNING) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    process.stderr.write(
      `failed to start daemon: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }
}

function cmdStop(config: ServerConfig): void {
  const signaled = stopDaemon(config);
  if (!signaled) {
    process.stdout.write("astack-server is not running\n");
    process.exit(0);
  }
  process.stdout.write("astack-server stop signal sent\n");
}

async function cmdStatus(config: ServerConfig): Promise<void> {
  const pid = readPidFile(config);
  const portInUse = await isPortInUse(config.host, config.port);
  if (pid !== null && isProcessAlive(pid)) {
    process.stdout.write(
      `astack-server: running (pid=${pid}, addr=${config.host}:${config.port}, port_in_use=${portInUse})\n`
    );
    process.exit(0);
  }
  if (portInUse) {
    process.stdout.write(
      `astack-server: port ${config.port} in use but no valid pidfile\n`
    );
    process.exit(1);
  }
  process.stdout.write("astack-server: not running\n");
  process.exit(2);
}

function cmdLogs(config: ServerConfig, args: string[]): void {
  const linesIdx = args.indexOf("--lines");
  const lines =
    linesIdx >= 0 && args[linesIdx + 1] ? parseInt(args[linesIdx + 1]!, 10) : 200;
  if (!fs.existsSync(config.logFile)) {
    process.stdout.write("no log file yet\n");
    return;
  }
  const content = fs.readFileSync(config.logFile, "utf8").split("\n");
  const tail = content.slice(-Math.max(lines, 1));
  process.stdout.write(tail.join("\n"));
}

// Only run main() when this file is invoked as a script (e.g. `node dist/bin.js`),
// not when a test file imports it to exercise parseNodeVersion / checkNodeVersion.
// Without this guard, `import { checkNodeVersion } from "../src/bin.js"` in a
// vitest run would trigger main() → cmdStart() → startDaemon() and surface as
// an unhandled promise rejection, failing the run.
const invokedAsScript =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (invokedAsScript) {
  main().catch((err) => {
    process.stderr.write(
      `fatal: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  });
}
