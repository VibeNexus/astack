/**
 * GET /api/events — Server-Sent Events stream.
 *
 * Wire format (per design.md § Eng Review decision 11):
 *   id:    <monotonic seq>
 *   event: <EventType>
 *   data:  <JSON payload matching AstackEventSchema[type]>
 *
 * Plus a heartbeat every 15s to prevent proxy timeouts and to let
 * clients detect a dead connection.
 *
 * Clients (Web dashboard, future CLI watcher) connect once and stay
 * connected. We don't persist event history across reconnects in v1;
 * on reconnect the client re-fetches current state via REST.
 */

import { EventType } from "@astack/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type { ServiceContainer } from "./container.js";

const HEARTBEAT_INTERVAL_MS = 15_000;

export function eventsRoutes(c: ServiceContainer): Hono {
  const app = new Hono();

  app.get("/events", (ctx) =>
    streamSSE(ctx, async (stream) => {
      // Send hello with current seq so clients know where they are.
      await stream.writeSSE({
        id: String(c.events.currentSeq()),
        event: EventType.Hello,
        data: JSON.stringify({
          type: EventType.Hello,
          payload: {
            server_version: "0.1.0",
            seq: c.events.currentSeq()
          }
        })
      });

      // Local shutdown flag — flipped by EventBus.shutdown() when the
      // daemon is going down. We can't rely on stream.aborted alone
      // because server.close() doesn't abort in-flight handlers.
      let shutdownRequested = false;
      const unsubscribeShutdown = c.events.onShutdown(() => {
        shutdownRequested = true;
        // Best-effort: close the stream so the while loop wakes up
        // from its sleep and server.close() can resolve.
        stream.close().catch(() => {
          /* already closed */
        });
      });

      // Subscribe to bus.
      const unsubscribe = c.events.subscribe((emitted) => {
        stream
          .writeSSE({
            id: String(emitted.seq),
            event: emitted.event.type,
            data: JSON.stringify(emitted.event)
          })
          .catch((err) => {
            c.logger.warn("sse.write_failed", {
              error: err instanceof Error ? err.message : String(err)
            });
          });
      });

      // Heartbeat loop — awaiting sleeps ensures the stream stays open.
      try {
        while (!stream.aborted && !stream.closed && !shutdownRequested) {
          await stream.sleep(HEARTBEAT_INTERVAL_MS);
          if (stream.aborted || stream.closed || shutdownRequested) break;
          await stream.writeSSE({
            event: EventType.Heartbeat,
            data: JSON.stringify({
              type: EventType.Heartbeat,
              payload: { ts: new Date().toISOString() }
            })
          });
        }
      } finally {
        unsubscribe();
        unsubscribeShutdown();
      }
    })
  );

  return app;
}
