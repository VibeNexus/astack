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
  createLogger,
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
  const logger = createLogger("info");
  try {
    const handle = await startDaemon(config, logger);
    installSignalHandlers(handle, logger);
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

export function runServerStop(): void {
  const config = loadConfig();
  const ok = stopDaemon(config);
  if (!ok) {
    printWarn("astack server is not running");
    process.exit(0);
  }
  printOk("stop signal sent");
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
