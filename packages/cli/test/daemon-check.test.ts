/**
 * Tests for ensureDaemonOnline.
 */

import { AstackError, ErrorCode } from "@astack/shared";
import { describe, expect, it, vi } from "vitest";

import { AstackClient } from "../src/client.js";
import { ensureDaemonOnline } from "../src/daemon-check.js";

function makeClient(fetchImpl: typeof fetch): AstackClient {
  return new AstackClient({ baseUrl: "http://127.0.0.1:7432", fetchImpl });
}

describe("ensureDaemonOnline", () => {
  it("returns health info on success", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ status: "ok", version: "0.1.0", uptime_ms: 100 }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    const info = await ensureDaemonOnline(makeClient(fetchImpl));
    expect(info.status).toBe("ok");
  });

  it("wraps SERVER_UNREACHABLE with a friendly message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    try {
      await ensureDaemonOnline(makeClient(fetchImpl));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AstackError);
      expect((err as AstackError).code).toBe(ErrorCode.SERVER_UNREACHABLE);
      expect((err as AstackError).message).toContain("astack server start");
    }
  });

  it("re-throws non-SERVER_UNREACHABLE errors unchanged", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ code: ErrorCode.INTERNAL, message: "oops" }),
        { status: 500 }
      )
    ) as unknown as typeof fetch;

    await expect(
      ensureDaemonOnline(makeClient(fetchImpl))
    ).rejects.toMatchObject({ code: ErrorCode.INTERNAL });
  });
});
