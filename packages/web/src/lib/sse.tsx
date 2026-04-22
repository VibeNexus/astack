import type * as React from "react";
/**
 * SSE event subscription hook.
 *
 * Connects to /api/events once on mount and exposes:
 *   - connection status (connecting | online | offline)
 *   - `onEvent(handler)` registration (returns an unsubscribe fn)
 *
 * See docs/asset/design.md § Eng Review decision 11 (SSE, zero polling).
 */

import type { AstackEvent } from "@astack/shared";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { PropsWithChildren } from "react";

export type SseStatus = "connecting" | "online" | "offline";

type Handler = (event: AstackEvent) => void;

interface SseContextValue {
  status: SseStatus;
  onEvent: (handler: Handler) => () => void;
}

const SseContext = createContext<SseContextValue | null>(null);

export function SseProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [status, setStatus] = useState<SseStatus>("connecting");
  const handlersRef = useRef(new Set<Handler>());
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const url = "/api/events";
    const source = new EventSource(url);
    sourceRef.current = source;

    source.onopen = () => setStatus("online");
    source.onerror = () => setStatus("offline");

    // Every AstackEvent type comes in as its own SSE event name; but the
    // server also duplicates the `type` field in the data payload so we
    // can subscribe to just the default 'message' channel when a custom
    // event name isn't provided. Attach a generic listener on all names.
    const listener = (e: MessageEvent): void => {
      try {
        const parsed = JSON.parse(e.data) as AstackEvent;
        handlersRef.current.forEach((h) => h(parsed));
      } catch {
        // Non-JSON or malformed — ignore; the server is the source of truth.
      }
    };

    // Register each known event name so the listener fires for all of them.
    // In practice EventSource also fires onmessage for events without an
    // explicit name, but our server emits named events, so we subscribe
    // with a wildcard pattern via known names.
    const namedEvents = [
      "hello",
      "heartbeat",
      "repo.registered",
      "repo.refreshed",
      "repo.removed",
      "project.registered",
      "project.removed",
      "sync.started",
      "skill.updated",
      "conflict.detected",
      "sync.completed",
      "linked_dir.created",
      "linked_dir.removed",
      "linked_dir.broken",
      "seed.completed",
      "harness.changed",
      // v0.5 bootstrap (see spec §A7)
      "subscriptions.bootstrap_needs_resolution",
      "subscriptions.bootstrap_resolved",
      // v0.7 local skills (see spec §A8)
      "local_skills.changed"
    ];
    for (const name of namedEvents) {
      source.addEventListener(name, listener);
    }

    return () => {
      for (const name of namedEvents) {
        source.removeEventListener(name, listener);
      }
      source.close();
      sourceRef.current = null;
    };
  }, []);

  const value: SseContextValue = {
    status,
    onEvent: (handler: Handler) => {
      handlersRef.current.add(handler);
      return () => {
        handlersRef.current.delete(handler);
      };
    }
  };

  return <SseContext.Provider value={value}>{children}</SseContext.Provider>;
}

export function useSse(): SseContextValue {
  const ctx = useContext(SseContext);
  if (!ctx) {
    throw new Error("useSse must be used inside an <SseProvider>");
  }
  return ctx;
}

/**
 * Subscribe to a specific event type with automatic cleanup.
 * Usage:
 *   useEventListener("skill.updated", (payload) => reload());
 */
export function useEventListener<TType extends AstackEvent["type"]>(
  type: TType,
  handler: (
    event: Extract<AstackEvent, { type: TType }>
  ) => void
): void {
  const { onEvent } = useSse();
  useEffect(() => {
    const unsubscribe = onEvent((e) => {
      if (e.type === type) {
        handler(e as Extract<AstackEvent, { type: TType }>);
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);
}
