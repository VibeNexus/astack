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

/** Called when the bus is being shut down (e.g. on SIGTERM/SIGINT). */
export type ShutdownHandler = () => void;

export class EventBus {
  private seq = 0;
  private readonly handlers = new Set<EventHandler>();
  private readonly shutdownHandlers = new Set<ShutdownHandler>();
  private shuttingDown = false;

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

  /**
   * Register a callback to be invoked once when the bus enters shutdown.
   * Primarily used by long-lived SSE handlers to break out of their
   * keep-alive loops so the HTTP server can close cleanly.
   *
   * If shutdown has already been requested, the handler fires synchronously.
   * Returns an unregister function for symmetry with `subscribe`.
   */
  onShutdown(handler: ShutdownHandler): () => void {
    if (this.shuttingDown) {
      try {
        handler();
      } catch {
        /* swallow */
      }
      return () => {
        /* noop */
      };
    }
    this.shutdownHandlers.add(handler);
    return () => this.shutdownHandlers.delete(handler);
  }

  /**
   * Signal all long-lived subscribers (SSE handlers) that the process is
   * going down so they can cleanly close their streams. Idempotent.
   */
  shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const h of this.shutdownHandlers) {
      try {
        h();
      } catch {
        /* one broken handler must not block the rest */
      }
    }
    this.shutdownHandlers.clear();
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
