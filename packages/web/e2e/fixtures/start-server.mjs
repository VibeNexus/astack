#!/usr/bin/env node
/**
 * Playwright webServer[0] entry.
 *
 * Boots a throwaway astack-server with:
 *   - An isolated tmp data dir (ASTACK_DATA_DIR=/tmp/astack-e2e-<ts>)
 *   - A non-default port (7433) so we can't clobber the user's real daemon
 *   - Seeds DISABLED (no real git clone of the 3 builtin repos)
 *
 * Lives in `e2e/fixtures/` instead of `packages/web/e2e/fixtures/` because
 * that's where Playwright resolves relative commands from (cwd is the
 * playwright config dir).
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/web/e2e/fixtures → packages/server
const serverDir = path.resolve(__dirname, "../../../server");
const dataDir = mkdtempSync(path.join(tmpdir(), "astack-e2e-"));

process.stdout.write(`[e2e-server] data dir: ${dataDir}\n`);

// Spawn the server bin directly (not via pnpm) so we can pass env vars
// cleanly and get a single child PID to manage.
const serverBin = path.join(serverDir, "dist", "bin.js");
const child = spawn(process.execPath, [serverBin, "start"], {
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    ASTACK_DATA_DIR: dataDir,
    ASTACK_PORT: "7433",
    // Skip SeedService so no real `git clone` happens during E2E boot.
    // (SeedService checks process.env.ASTACK_DISABLE_SEEDS in v0.3 — see
    //  spec § 4 PR0. If not yet wired, the seed attempt is async and
    //  non-blocking so tests still pass; we just pay a harmless network call.)
    ASTACK_DISABLE_SEEDS: "1"
  }
});

function shutdown() {
  if (!child.killed) {
    child.kill("SIGTERM");
    // Give the daemon a moment to release the port before cleanup.
    setTimeout(() => {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }, 500);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", shutdown);

child.on("exit", (code, signal) => {
  process.stdout.write(
    `[e2e-server] exited code=${code} signal=${signal}\n`
  );
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  process.exit(code ?? 0);
});
