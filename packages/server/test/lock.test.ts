/**
 * Tests for LockManager — the per-repo mutex that serializes git operations.
 *
 * Covers the 3 scenarios called out in design.md:
 *   - Single-holder acquire/release.
 *   - Contended queue handoff (FIFO).
 *   - Timeout raising REPO_BUSY.
 */

import { AstackError, ErrorCode } from "@astack/shared";
import { describe, expect, it, vi } from "vitest";

import { LockManager } from "../src/lock.js";

function defer(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("LockManager", () => {
  it("returns an immediate release fn when uncontended", async () => {
    const mgr = new LockManager({ timeoutMs: 1000 });
    const release = await mgr.acquire(1);
    expect(mgr.isHeld(1)).toBe(true);
    release();
    expect(mgr.isHeld(1)).toBe(false);
  });

  it("serializes operations on the same repo id", async () => {
    const mgr = new LockManager({ timeoutMs: 5000 });
    const order: string[] = [];

    const { promise: gateA, resolve: finishA } = defer();
    const { promise: gateB, resolve: finishB } = defer();

    const runA = mgr.withLock(7, async () => {
      order.push("A-start");
      await gateA;
      order.push("A-end");
    });

    // Small delay to ensure A acquires first.
    await new Promise((r) => setTimeout(r, 10));

    const runB = mgr.withLock(7, async () => {
      order.push("B-start");
      await gateB;
      order.push("B-end");
    });

    // At this point: A holds lock, B is queued.
    expect(mgr.isHeld(7)).toBe(true);
    expect(mgr.queueSize(7)).toBe(1);

    finishA();
    await runA;
    // B should now be able to proceed.
    finishB();
    await runB;

    expect(order).toEqual(["A-start", "A-end", "B-start", "B-end"]);
  });

  it("allows parallel operations on different repo ids", async () => {
    const mgr = new LockManager({ timeoutMs: 5000 });
    let inFlight = 0;
    let peak = 0;

    async function op(id: number): Promise<void> {
      await mgr.withLock(id, async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
      });
    }

    await Promise.all([op(1), op(2), op(3)]);
    expect(peak).toBe(3);
  });

  it("throws REPO_BUSY when waiting times out", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new LockManager({ timeoutMs: 100 });

      // Hold the lock forever — never release during this test.
      const releaseFirst = await mgr.acquire(42);

      // Attach catch handler immediately so Node does not mark this as
      // an unhandled rejection while timers are advancing.
      const waitPromise = mgr.acquire(42).catch((e) => e);

      await vi.advanceTimersByTimeAsync(100);

      const result = await waitPromise;
      expect(result).toMatchObject({ code: ErrorCode.REPO_BUSY });

      releaseFirst();
    } finally {
      vi.useRealTimers();
    }
  });

  it("REPO_BUSY error includes waited_ms in details", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new LockManager({ timeoutMs: 50 });
      const hold = await mgr.acquire(9);

      const wait = mgr.acquire(9).catch((e) => e);
      await vi.advanceTimersByTimeAsync(50);

      const err = await wait;
      expect(err).toBeInstanceOf(AstackError);
      expect((err as AstackError).details).toEqual({
        repo_id: 9,
        waited_ms: 50
      });

      hold();
    } finally {
      vi.useRealTimers();
    }
  });

  it("withLock releases the lock even if the body throws", async () => {
    const mgr = new LockManager({ timeoutMs: 1000 });

    await expect(
      mgr.withLock(1, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(mgr.isHeld(1)).toBe(false);

    // Subsequent acquire should succeed immediately.
    const release = await mgr.acquire(1);
    release();
  });
});
