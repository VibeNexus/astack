/**
 * Tests for error code infrastructure.
 *
 * Verifies the wire contract: all codes have an HTTP status mapping,
 * round-trip serialization preserves shape, and `instanceof` works.
 */

import { describe, expect, it } from "vitest";

import {
  AstackError,
  ErrorCode,
  ErrorHttpStatus,
  type AstackErrorBody
} from "../src/errors.js";

describe("ErrorCode registry", () => {
  it("every code has an HTTP status mapping", () => {
    for (const code of Object.values(ErrorCode)) {
      expect(
        ErrorHttpStatus[code],
        `missing HTTP status for ${code}`
      ).toBeGreaterThanOrEqual(400);
      expect(ErrorHttpStatus[code]).toBeLessThan(600);
    }
  });

  it("HTTP status mapping has no extra entries not in ErrorCode", () => {
    const codes = new Set<string>(Object.values(ErrorCode));
    for (const key of Object.keys(ErrorHttpStatus)) {
      expect(codes.has(key), `ErrorHttpStatus has stale entry: ${key}`).toBe(true);
    }
  });
});

describe("AstackError", () => {
  it("preserves instanceof across construction", () => {
    const err = new AstackError(ErrorCode.REPO_NOT_FOUND, "not found", {
      repo_id: 42
    });
    expect(err).toBeInstanceOf(AstackError);
    expect(err).toBeInstanceOf(Error);
  });

  it("carries code, message, and details", () => {
    const err = new AstackError(ErrorCode.REPO_BUSY, "locked", {
      waited_ms: 30_000
    });
    expect(err.code).toBe(ErrorCode.REPO_BUSY);
    expect(err.message).toBe("locked");
    expect(err.details).toEqual({ waited_ms: 30_000 });
  });

  it("serializes to wire format via toJSON", () => {
    const err = new AstackError(ErrorCode.CONFLICT_DETECTED, "conflict", {
      skill_id: 7
    });
    const wire = err.toJSON();
    expect(wire).toEqual<AstackErrorBody>({
      code: ErrorCode.CONFLICT_DETECTED,
      message: "conflict",
      details: { skill_id: 7 }
    });
  });

  it("round-trips via fromJSON", () => {
    const original = new AstackError(ErrorCode.REPO_GIT_FAILED, "git push rejected", {
      git_stderr: "remote rejected"
    });
    const restored = AstackError.fromJSON(original.toJSON());

    expect(restored).toBeInstanceOf(AstackError);
    expect(restored.code).toBe(original.code);
    expect(restored.message).toBe(original.message);
    expect(restored.details).toEqual(original.details);
  });

  it("toJSON preserves undefined details as undefined (not null)", () => {
    const err = new AstackError(ErrorCode.NOT_IMPLEMENTED, "todo");
    expect(err.toJSON().details).toBeUndefined();
  });
});
