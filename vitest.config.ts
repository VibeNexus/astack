import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // node:sqlite is a Node-only built-in module (added v22.5, unflagged
    // v22.13). Vite's dependency resolver in v5 doesn't always recognize
    // the `node:` prefix for recently-added builtins — inlining NOTHING
    // but externalizing it explicitly works around the bundler.
    server: {
      deps: {
        external: [/^node:sqlite$/]
      }
    },
    // E2E specs in packages/web/e2e/ are Playwright, not vitest. They
    // share the `.spec.ts` suffix for Playwright's default pattern, so we
    // exclude them here or vitest tries to run them and crashes because
    // `test.describe` from `@playwright/test` is incompatible with vitest.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/e2e/**"
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90
      },
      exclude: [
        "**/dist/**",
        "**/node_modules/**",
        "**/*.config.*",
        "**/bin.ts",
        "**/e2e/**"
      ]
    }
  }
});
