/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      // Cover only the code we unit-test here: utility lib + primitive UI
      // components + routing shell. Page components are intentionally
      // excluded (they're thin fetch+render layers, covered end-to-end by
      // the daemon-level integration tests in @astack/cli + manual QA).
      include: [
        "src/App.tsx",
        "src/lib/**",
        "src/components/**"
      ],
      exclude: [
        "**/dist/**",
        "**/node_modules/**",
        "**/*.config.*",
        "src/main.tsx"
      ],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 70,
        statements: 80
      }
    }
  }
});
