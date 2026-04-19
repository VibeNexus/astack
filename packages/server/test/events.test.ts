/**
 * Tests for EventBus — in-process pub/sub for SSE fan-out.
 */

import { EventType } from "@astack/shared";
import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../src/events.js";

describe("EventBus", () => {
  it("assigns monotonically increasing seq numbers", () => {
    const bus = new EventBus();
    const a = bus.emit({ type: EventType.Heartbeat, payload: { ts: "1" } });
    const b = bus.emit({ type: EventType.Heartbeat, payload: { ts: "2" } });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(bus.currentSeq()).toBe(2);
  });

  it("delivers events to all subscribed handlers", () => {
    const bus = new EventBus();
    const seen1: number[] = [];
    const seen2: number[] = [];
    bus.subscribe((e) => seen1.push(e.seq));
    bus.subscribe((e) => seen2.push(e.seq));

    bus.emit({ type: EventType.Heartbeat, payload: { ts: "x" } });
    bus.emit({ type: EventType.Heartbeat, payload: { ts: "y" } });

    expect(seen1).toEqual([1, 2]);
    expect(seen2).toEqual([1, 2]);
  });

  it("returns an unsubscribe function", () => {
    const bus = new EventBus();
    const seen: number[] = [];
    const unsub = bus.subscribe((e) => seen.push(e.seq));

    bus.emit({ type: EventType.Heartbeat, payload: { ts: "1" } });
    unsub();
    bus.emit({ type: EventType.Heartbeat, payload: { ts: "2" } });

    expect(seen).toEqual([1]);
    expect(bus.subscriberCount()).toBe(0);
  });

  it("isolates handler failures (one bad handler does not break others)", () => {
    const bus = new EventBus();
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    bus.subscribe(bad);
    bus.subscribe(good);

    bus.emit({ type: EventType.Heartbeat, payload: { ts: "x" } });

    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });
});
