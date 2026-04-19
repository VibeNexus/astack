/**
 * Unit tests for `astack server` subcommands.
 *
 * The command functions all call `process.exit` on certain paths. We
 * intercept that via vi.spyOn to avoid killing the test process.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import tmp from "tmp-promise";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runServerLogs,
  runServerStatus,
  runServerStop
} from "../src/commands/server.js";

// Capture process.exit so tests don't terminate early.
function mockExit(): {
  exitCodes: number[];
  restore: () => void;
} {
  const exitCodes: number[] = [];
  const spy = vi
    .spyOn(process, "exit")
    .mockImplementation(((code?: number | null) => {
      exitCodes.push(typeof code === "number" ? code : 0);
      // Throw so the caller short-circuits but we can still observe.
      throw new Error(`__test_exit_${code ?? 0}__`);
    }) as never);
  return {
    exitCodes,
    restore: () => spy.mockRestore()
  };
}

function captureStdout<T>(fn: () => Promise<T> | T): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write;
  process.stdout.write = ((data: string | Uint8Array) => {
    chunks.push(typeof data === "string" ? data : Buffer.from(data).toString());
    return true;
  }) as unknown as typeof process.stdout.write;
  return Promise.resolve()
    .then(() => fn())
    .catch(() => {
      // swallow — tests inspect the output, not the exit exception
    })
    .finally(() => {
      process.stdout.write = orig;
    })
    .then(() => chunks.join(""));
}

describe("astack server subcommands", () => {
  let dir: tmp.DirectoryResult;
  let origHome: string | undefined;

  beforeEach(async () => {
    dir = await tmp.dir({ unsafeCleanup: true });
    // Point ASTACK_DATA_DIR at the tmp dir so the commands don't touch
    // the real ~/.astack/.
    origHome = process.env.ASTACK_DATA_DIR;
    process.env.ASTACK_DATA_DIR = dir.path;
  });

  afterEach(async () => {
    if (origHome === undefined) delete process.env.ASTACK_DATA_DIR;
    else process.env.ASTACK_DATA_DIR = origHome;
    await dir.cleanup();
  });

  describe("runServerStop", () => {
    it("prints 'not running' when no pidfile exists", async () => {
      const exit = mockExit();
      try {
        const out = await captureStdout(() => runServerStop());
        expect(out).toContain("not running");
        expect(exit.exitCodes).toEqual([0]);
      } finally {
        exit.restore();
      }
    });
  });

  describe("runServerStatus", () => {
    it("prints 'not running' with exit 2 when nothing is up", async () => {
      const exit = mockExit();
      try {
        const out = await captureStdout(() => runServerStatus());
        expect(out).toContain("not running");
        expect(exit.exitCodes).toEqual([2]);
      } finally {
        exit.restore();
      }
    });

    it("prints running info when pidfile points to current process", async () => {
      // Write our own PID into the pidfile so isProcessAlive() is happy.
      fs.mkdirSync(dir.path, { recursive: true });
      fs.writeFileSync(path.join(dir.path, "daemon.pid"), String(process.pid));
      const exit = mockExit();
      try {
        const out = await captureStdout(() => runServerStatus());
        expect(out).toContain("running");
        expect(out).toContain(`pid=${process.pid}`);
      } finally {
        exit.restore();
      }
    });
  });

  describe("runServerLogs", () => {
    it("prints 'no log file yet' when logfile is missing", async () => {
      const out = await captureStdout(() => runServerLogs(50));
      expect(out).toContain("no log file");
    });

    it("prints the tail of the log file", async () => {
      fs.mkdirSync(dir.path, { recursive: true });
      const logPath = path.join(dir.path, "daemon.log");
      fs.writeFileSync(
        logPath,
        Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n") + "\n"
      );
      // Note: file ends with `\n`, so split("\n") yields 11 entries with the
      // last being empty. Request 4 so we definitely see line-7/8/9.
      const out = await captureStdout(() => runServerLogs(4));
      expect(out).toContain("line-7");
      expect(out).toContain("line-8");
      expect(out).toContain("line-9");
    });

    // Silence an unused import warning.
    void os;
  });
});
