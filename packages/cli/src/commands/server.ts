/**
 * `astack server <start|stop|status|logs>` — daemon lifecycle.
 *
 * Delegates to the same helpers @astack/server uses. We launch the daemon
 * in-process for `start` so Ctrl+C works naturally; for `stop` and
 * `status` we only read pidfile + port, which doesn't require server code.
 */

import fs from "node:fs";

import { AstackError, ErrorCode } from "@astack/shared";
import {
  installSignalHandlers,
  isPortInUse,
  isProcessAlive,
  loadConfig,
  readPidFile,
  startDaemon,
  stopDaemon
} from "@astack/server";

import { print, printErr, printInfo, printOk, printWarn } from "../output.js";

/* v8 ignore start */
export async function runServerStart(): Promise<void> {
  const config = loadConfig();
  try {
    // v0.6: startDaemon constructs its own tee logger (stderr +
    // config.logFile) and returns it on handle.logger; pass that same
    // logger to installSignalHandlers so shutdown logs land in the
    // same file as everything else.
    const handle = await startDaemon(config);
    installSignalHandlers(handle, handle.logger);
    printOk(
      `astack-server listening on http://${config.host}:${config.port}`
    );
    // The Node event loop stays alive via the TCP server.
  } catch (err) {
    if (err instanceof AstackError && err.code === ErrorCode.SERVER_ALREADY_RUNNING) {
      printErr(err.message);
      process.exit(1);
    }
    throw err;
  }
}
/* v8 ignore stop */

export async function runServerStop(): Promise<void> {
  const config = loadConfig();
  const pid = readPidFile(config);
  const ok = stopDaemon(config);
  if (!ok) {
    printWarn("astack server is not running");
    process.exit(0);
  }

  // Wait for the process to actually exit before returning.
  // Without this, a rapid `stop && start` sees the old process still
  // holding the port / pidfile and fails with "already running".
  const TIMEOUT_MS = 5_000;
  const POLL_MS = 100;
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (!isProcessAlive(pid!)) {
      printOk("stop signal sent");
      return;
    }
  }

  // Timed out — process didn't die; warn and let the user handle it.
  printWarn(`stop signal sent but process ${pid} still alive after ${TIMEOUT_MS / 1000}s`);
  printWarn(`Force-kill with: kill -9 ${pid}`);
}

export async function runServerStatus(): Promise<void> {
  const config = loadConfig();
  const pid = readPidFile(config);
  const portInUse = await isPortInUse(config.host, config.port);
  if (pid !== null && isProcessAlive(pid)) {
    printInfo(
      `running  pid=${pid}  addr=${config.host}:${config.port}  port_in_use=${portInUse}`
    );
    return;
  }
  if (portInUse) {
    printWarn(`port ${config.port} in use but no valid pidfile`);
    process.exit(1);
  }
  printWarn("not running");
  process.exit(2);
}

export function runServerLogs(lines: number = 200): void {
  const config = loadConfig();
  if (!fs.existsSync(config.logFile)) {
    printWarn("no log file yet");
    return;
  }
  const content = fs.readFileSync(config.logFile, "utf8").split("\n");
  const tail = content.slice(-Math.max(lines, 1));
  print(tail.join("\n"));
}
