import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
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
        "**/bin.ts"
      ]
    }
  }
});
