/**
 * Tests for format helpers.
 */

import { SubscriptionState, LinkedDirStatus } from "@astack/shared";
import { describe, expect, it } from "vitest";

import {
  relativeTime,
  shortHash,
  subscriptionPriority,
  subscriptionStatusInfo,
  linkedDirStatusInfo
} from "../src/lib/format.js";

describe("shortHash", () => {
  it("returns '—' for null/undefined", () => {
    expect(shortHash(null)).toBe("—");
    expect(shortHash(undefined)).toBe("—");
  });

  it("truncates to 7 chars", () => {
    expect(shortHash("abc1234defg")).toBe("abc1234");
  });
});

describe("relativeTime", () => {
  it("returns '—' for null", () => {
    expect(relativeTime(null)).toBe("—");
  });

  it("shows seconds, minutes, hours, days", () => {
    const now = Date.now();
    expect(relativeTime(new Date(now - 3_000).toISOString())).toBe("3s ago");
    expect(relativeTime(new Date(now - 65_000).toISOString())).toBe("1m ago");
    expect(relativeTime(new Date(now - 2 * 3_600_000).toISOString())).toBe(
      "2h ago"
    );
    expect(relativeTime(new Date(now - 3 * 86_400_000).toISOString())).toBe(
      "3d ago"
    );
  });

  it("passes through bogus input unchanged", () => {
    expect(relativeTime("not-a-date")).toBe("not-a-date");
  });
});

describe("subscriptionStatusInfo", () => {
  it("maps each state to a label + tone + symbol", () => {
    for (const state of Object.values(SubscriptionState)) {
      const info = subscriptionStatusInfo(state);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.symbol.length).toBeGreaterThan(0);
      expect(["accent", "warn", "error", "muted"]).toContain(info.tone);
    }
  });

  it("conflict uses error tone", () => {
    expect(subscriptionStatusInfo(SubscriptionState.Conflict).tone).toBe("error");
  });
});

describe("subscriptionPriority", () => {
  it("puts conflicts first", () => {
    expect(subscriptionPriority(SubscriptionState.Conflict)).toBe(0);
    expect(subscriptionPriority(SubscriptionState.Synced)).toBe(4);
  });

  it("is monotonic across the common attention states", () => {
    const p = [
      subscriptionPriority(SubscriptionState.Conflict),
      subscriptionPriority(SubscriptionState.Behind),
      subscriptionPriority(SubscriptionState.LocalAhead),
      subscriptionPriority(SubscriptionState.Pending),
      subscriptionPriority(SubscriptionState.Synced)
    ];
    for (let i = 1; i < p.length; i++) {
      expect(p[i]).toBeGreaterThanOrEqual(p[i - 1]!);
    }
  });
});

describe("linkedDirStatusInfo", () => {
  it("maps each status to a label + tone", () => {
    expect(linkedDirStatusInfo(LinkedDirStatus.Active).tone).toBe("accent");
    expect(linkedDirStatusInfo(LinkedDirStatus.Broken).tone).toBe("error");
    expect(linkedDirStatusInfo(LinkedDirStatus.Removed).tone).toBe("muted");
  });
});
