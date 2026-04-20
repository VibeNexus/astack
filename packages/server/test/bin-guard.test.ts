/**
 * Tests for the Node.js version guard in bin.ts.
 *
 * parseNodeVersion / checkNodeVersion are exported for this purpose —
 * keeping the real `main()` flow clean while giving us unit-test level
 * coverage of the gate logic.
 */

import { describe, expect, it, vi } from "vitest";

import { checkNodeVersion, parseNodeVersion } from "../src/bin.js";

describe("parseNodeVersion", () => {
  it.each([
    ["22.13.0", true],
    ["22.13.1", true],
    ["22.99.0", true],
    ["23.0.0", true],
    ["24.14.1", true],
    ["25.8.2", true],
    ["v22.13.0", true],
    ["22.12.99", false],
    ["22.12.0", false],
    ["22.5.0", false],
    ["22.0.0", false],
    ["21.0.0", false],
    ["20.18.0", false],
    ["v20.18.0", false]
  ])("%s → ok=%s", (input, expected) => {
    expect(parseNodeVersion(input).ok).toBe(expected);
  });

  it("parses the major/minor/patch tuple", () => {
    expect(parseNodeVersion("v22.13.4").parsed).toEqual({
      major: 22,
      minor: 13,
      patch: 4
    });
  });

  it("treats unparseable input as not-ok", () => {
    expect(parseNodeVersion("garbage").ok).toBe(false);
    expect(parseNodeVersion("").ok).toBe(false);
  });
});

describe("checkNodeVersion", () => {
  it("is a no-op on a supported version", () => {
    const exit = vi.fn(() => {
      throw new Error("should not exit");
    }) as unknown as (n: number) => never;
    const write = vi.fn();
    expect(() => checkNodeVersion("24.14.1", exit, write)).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("exits 1 with a helpful message on old Node", () => {
    const exit = vi.fn(() => {
      throw new Error("__exit__");
    }) as unknown as (n: number) => never;
    const write = vi.fn();
    expect(() => checkNodeVersion("22.12.0", exit, write)).toThrow("__exit__");
    expect(exit).toHaveBeenCalledWith(1);
    expect(write).toHaveBeenCalledOnce();
    const msg = (write.mock.calls[0] as [string])[0];
    expect(msg).toMatch(/22\.13/);
    expect(msg).toMatch(/22\.12\.0/);
    expect(msg).toMatch(/node:sqlite/);
  });
});
