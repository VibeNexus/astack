/**
 * Tests for the minimal JSON logger.
 */

import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLogger, nullLogger } from "../src/logger.js";

function collectingStream(): { stream: Writable; output: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    }
  });
  return {
    stream,
    output: () => Buffer.concat(chunks).toString("utf8")
  };
}

describe("createLogger", () => {
  it("writes timestamp + level + event to the stream", () => {
    const { stream, output } = collectingStream();
    const log = createLogger("debug", stream);
    log.info("test.event");

    const line = output().trim();
    expect(line).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO {2}test\.event$/
    );
  });

  it("appends key=value fields, JSON-encoding non-strings", () => {
    const { stream, output } = collectingStream();
    const log = createLogger("info", stream);
    log.info("op", { id: 1, name: "x", nested: { a: 1 } });
    const line = output().trim();
    expect(line.endsWith("op id=1 name=x nested={\"a\":1}")).toBe(true);
  });

  it("omits undefined fields", () => {
    const { stream, output } = collectingStream();
    const log = createLogger("info", stream);
    log.info("op", { a: 1, b: undefined, c: 2 });
    expect(output().trim().endsWith("op a=1 c=2")).toBe(true);
  });

  it("filters by minimum log level", () => {
    const { stream, output } = collectingStream();
    const log = createLogger("warn", stream);
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    const lines = output().trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("WARN  w");
    expect(lines[1]).toContain("ERROR e");
  });

  it("all levels work when minLevel=debug", () => {
    const { stream, output } = collectingStream();
    const log = createLogger("debug", stream);
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(output().trim().split("\n")).toHaveLength(4);
  });
});

describe("nullLogger", () => {
  it("does not throw or produce output", () => {
    const log = nullLogger();
    expect(() => {
      log.debug("x");
      log.info("x");
      log.warn("x");
      log.error("x");
    }).not.toThrow();
  });
});
