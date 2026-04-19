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

async function main(): Promise<void> {
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
  try {
    const handle = await startDaemon(config, logger);
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

main().catch((err) => {
  process.stderr.write(
    `fatal: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});
