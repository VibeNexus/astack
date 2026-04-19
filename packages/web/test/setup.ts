/**
 * Vitest setup — testing-library/jest-dom matchers + cleanup between tests.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

// Polyfill EventSource for jsdom. Tests that need SSE mock this per-test;
// this is a no-op class to keep SseProvider happy during unrelated tests.
class NoopEventSource {
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  onmessage: unknown = null;
  onopen: unknown = null;
  onerror: unknown = null;
  readyState = 0;
  url = "";
  withCredentials = false;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  CONNECTING = 0;
  OPEN = 1;
  CLOSED = 2;
}
// @ts-expect-error — minimal polyfill for unit tests
globalThis.EventSource = NoopEventSource;
