/**
 * In-process event bus for SSE fan-out.
 *
 * Architecture:
 *   Services call `events.emit(event)` after successful mutations.
 *   SSE HTTP handler subscribes via `events.subscribe(handler)`.
 *   No external queue; single-user local daemon, single process.
 *
 * Event shape matches `AstackEvent` from @astack/shared (validated at
 * emit boundary for type safety; not re-validated on fan-out).
 *
 * Also assigns a monotonic `seq` per-emission, which clients can use
 * to detect gaps across reconnects (future enhancement).
 */

import type { AstackEvent } from "@astack/shared";

export interface EmittedEvent {
  seq: number;
  event: AstackEvent;
}

export type EventHandler = (emitted: EmittedEvent) => void;

export class EventBus {
  private seq = 0;
  private readonly handlers = new Set<EventHandler>();

  emit(event: AstackEvent): EmittedEvent {
    this.seq += 1;
    const emitted: EmittedEvent = { seq: this.seq, event };
    // Dispatch synchronously; handlers are expected to be fast
    // (just enqueue the SSE write).
    for (const h of this.handlers) {
      try {
        h(emitted);
      } catch {
        // A broken handler should not prevent others from receiving.
        // The SSE handler itself is responsible for catching its own errors.
      }
    }
    return emitted;
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Diagnostic: number of active subscribers (used by `status` endpoint). */
  subscriberCount(): number {
    return this.handlers.size;
  }

  /** Diagnostic: current seq (used by `hello` event payload). */
  currentSeq(): number {
    return this.seq;
  }
}
