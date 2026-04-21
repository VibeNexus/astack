/**
 * PR1 schema-level tests for the v0.5 bootstrap SSE events.
 *
 * Confirms:
 *   - SubscriptionsBootstrapNeedsResolution / SubscriptionsBootstrapResolved
 *     are part of AstackEventSchema's discriminated union
 *   - ambiguous_count: 0 on NeedsResolution is rejected (positive constraint)
 */

import { describe, expect, it } from "vitest";

import {
  AstackEventSchema,
  EventType
} from "@astack/shared";

describe("AstackEventSchema — v0.5 bootstrap events", () => {
  it("accepts SubscriptionsBootstrapNeedsResolution with ambiguous_count > 0", () => {
    const event = {
      type: EventType.SubscriptionsBootstrapNeedsResolution,
      payload: {
        project_id: 1,
        matched_count: 2,
        ambiguous_count: 3,
        unmatched_count: 0,
        auto_subscribed_count: 2
      }
    };
    const parsed = AstackEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
  });

  it("rejects SubscriptionsBootstrapNeedsResolution with ambiguous_count: 0", () => {
    const event = {
      type: EventType.SubscriptionsBootstrapNeedsResolution,
      payload: {
        project_id: 1,
        matched_count: 0,
        ambiguous_count: 0,
        unmatched_count: 0,
        auto_subscribed_count: 0
      }
    };
    const parsed = AstackEventSchema.safeParse(event);
    expect(parsed.success).toBe(false);
  });

  it("accepts SubscriptionsBootstrapResolved with all-zero counts", () => {
    const event = {
      type: EventType.SubscriptionsBootstrapResolved,
      payload: {
        project_id: 1,
        remaining_ambiguous_count: 0,
        subscribed_count: 0,
        ignored_count: 0
      }
    };
    const parsed = AstackEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
  });

  it("accepts SubscriptionsBootstrapResolved with positive subscribed_count", () => {
    const event = {
      type: EventType.SubscriptionsBootstrapResolved,
      payload: {
        project_id: 7,
        remaining_ambiguous_count: 0,
        subscribed_count: 5,
        ignored_count: 1
      }
    };
    const parsed = AstackEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
  });
});
