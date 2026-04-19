/**
 * Smoke test for @astack/server public surface.
 *
 * Keeps `index.ts` covered and acts as a safety net — if we remove or
 * rename a public export by accident, this test breaks.
 */

import { describe, expect, it } from "vitest";

import * as pkg from "../src/index.js";

describe("@astack/server public surface", () => {
  it("exports VERSION", () => {
    expect(pkg.VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exports core primitives", () => {
    expect(typeof pkg.loadConfig).toBe("function");
    expect(typeof pkg.createLogger).toBe("function");
    expect(typeof pkg.nullLogger).toBe("function");
    expect(typeof pkg.openDatabase).toBe("function");
    expect(typeof pkg.deriveNameFromUrl).toBe("function");
  });

  it("exports core classes", () => {
    expect(typeof pkg.LockManager).toBe("function");
    expect(typeof pkg.EventBus).toBe("function");
    expect(typeof pkg.RepoService).toBe("function");
  });
});
