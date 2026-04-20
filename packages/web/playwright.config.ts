import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E config for @astack/web.
 *
 * Boot sequence (see e2e/fixtures/server.ts):
 *   1. webServer[0]:  start astack-server on a random free port using a tmp ASTACK_DATA_DIR
 *   2. webServer[1]:  start vite dev server on :5173, proxying /api and /health
 *                     to the daemon launched in step 1 (ASTACK_E2E_PORT env var)
 *   3. tests run against http://127.0.0.1:5173
 *
 * Local run:   pnpm --filter @astack/web test:e2e
 * Single file: pnpm --filter @astack/web test:e2e e2e/smoke.spec.ts
 * Debug UI:    pnpm --filter @astack/web test:e2e:ui
 *
 * On CI, `npx playwright install --with-deps chromium` must run before this.
 */
export default defineConfig({
  testDir: "./e2e",
  // Serial by default: every test mutates the shared E2E daemon state
  // (projects, repos, sync-logs), so parallel runs cause cross-test
  // bleed-through. If CI wall time becomes a problem, we'll shard across
  // multiple daemon instances, not threads.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: [
    {
      // Boots a throwaway astack-server on ASTACK_E2E_PORT (7433) with a
      // per-run tmp data dir. --seeds=false prevents real git clones.
      command: "node ./e2e/fixtures/start-server.mjs",
      port: 7433,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe"
    },
    {
      command: "pnpm dev",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        // Override vite proxy target to hit the e2e daemon, not a user's
        // real daemon on 7432.
        ASTACK_E2E_PORT: "7433"
      }
    }
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    },
    {
      // Responsive verification. See v0.3 spec § Pass 6.
      name: "mobile",
      use: { ...devices["iPhone 13"] }
    }
  ]
});
