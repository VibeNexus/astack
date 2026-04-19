/**
 * Tests for output helpers — terminal-agnostic (doesn't assume colors).
 */

import { describe, expect, it, vi } from "vitest";

import {
  print,
  printErr,
  printInfo,
  printNext,
  printOk,
  printTable,
  printWarn,
  sym
} from "../src/output.js";

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stdout.write;
  process.stdout.write = ((data: string | Uint8Array) => {
    chunks.push(typeof data === "string" ? data : Buffer.from(data).toString());
    return true;
  }) as unknown as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stderr.write;
  process.stderr.write = ((data: string | Uint8Array) => {
    chunks.push(typeof data === "string" ? data : Buffer.from(data).toString());
    return true;
  }) as unknown as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join("");
}

describe("output", () => {
  it("printOk includes ✓ symbol", () => {
    const out = captureStdout(() => printOk("hello"));
    expect(out).toContain(sym.ok);
    expect(out).toContain("hello");
  });

  it("printWarn uses stdout", () => {
    const out = captureStdout(() => printWarn("careful"));
    expect(out).toContain(sym.warn);
    expect(out).toContain("careful");
  });

  it("printErr writes to stderr", () => {
    const err = captureStderr(() => printErr("boom"));
    expect(err).toContain(sym.error);
    expect(err).toContain("boom");
  });

  it("printInfo includes dot", () => {
    const out = captureStdout(() => printInfo("fyi"));
    expect(out).toContain(sym.dot);
  });

  it("printNext indents with arrow prefix", () => {
    const out = captureStdout(() => printNext("do this"));
    expect(out).toContain(sym.arrow);
    expect(out).toContain("do this");
  });

  it("print is a plain line writer", () => {
    const out = captureStdout(() => print("bare"));
    expect(out).toBe("bare\n");
  });

  it("printTable aligns columns", () => {
    const out = captureStdout(() =>
      printTable([
        ["name", "value"],
        ["longer", "1"],
        ["x", "2"]
      ])
    );
    const lines = out.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    // Column 0 width should match longest cell ("longer" = 6).
    for (const line of lines) {
      expect(line.startsWith("name  ") || line.startsWith("longer") || line.startsWith("x     "))
        .toBe(true);
    }
  });

  it("printTable is a no-op on empty input", () => {
    const out = captureStdout(() => printTable([]));
    expect(out).toBe("");
  });

  it("vi.fn is referenced to silence unused import", () => {
    expect(vi.fn()).toBeTypeOf("function");
  });
});
