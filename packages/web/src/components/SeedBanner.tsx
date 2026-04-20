import type * as React from "react";
/**
 * SeedBanner — dismissable banner shown when SeedService reports failures.
 *
 * Appears at the top of the content area when the `seed.completed` SSE
 * event arrives with `failed > 0`. Dismissal is persisted in localStorage
 * keyed by the set of failed names, so:
 *   - if the same seeds fail again next daemon restart, the banner
 *     respects your earlier dismissal
 *   - if a different set of seeds fails later, it'll show a fresh banner
 *
 * Rationale (v0.2 Spec § TODO-2 / critical gap):
 *   If all three builtin seeds fail on first start (no network, DNS
 *   down), the dashboard would otherwise show an empty Repos list
 *   with no explanation of "it tried but failed". This banner gives
 *   the user the names + a hint.
 */

import { useCallback, useState } from "react";

import { useEventListener } from "../lib/sse.js";

const STORAGE_KEY = "astack:seed-banner-dismissed";

interface DismissState {
  /** Sorted failed names joined with "," — the fingerprint of this failure. */
  fingerprint: string;
}

function readDismissed(): DismissState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as DismissState;
  } catch {
    return null;
  }
}

function writeDismissed(state: DismissState | null): void {
  try {
    if (state === null) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  } catch {
    // Private-mode / quota — just skip persistence; banner will reappear
    // on next page load until the underlying failure is resolved.
  }
}

function fingerprint(names: readonly string[]): string {
  return [...names].sort().join(",");
}

export function SeedBanner(): React.JSX.Element | null {
  const [failedNames, setFailedNames] = useState<string[] | null>(null);

  // Hide on mount if the last-dismissed fingerprint matches current
  // failure set. The first seed.completed event after mount will
  // re-evaluate.
  useEventListener("seed.completed", (event) => {
    const names = event.payload.failed_names;
    if (event.payload.failed === 0) {
      setFailedNames(null);
      return;
    }
    const dismissed = readDismissed();
    if (dismissed && dismissed.fingerprint === fingerprint(names)) {
      // User already dismissed this specific failure set.
      setFailedNames(null);
      return;
    }
    setFailedNames(names);
  });

  const dismiss = useCallback(() => {
    if (failedNames !== null) {
      writeDismissed({ fingerprint: fingerprint(failedNames) });
    }
    setFailedNames(null);
  }, [failedNames]);

  // Nothing to show.
  if (failedNames === null || failedNames.length === 0) return null;

  const heading =
    failedNames.length === 1
      ? "1 recommended repo failed to load"
      : `${failedNames.length} recommended repos failed to load`;

  return (
    <div
      role="alert"
      className="mb-6 flex items-start gap-3 rounded-lg border border-warn/30 bg-warn/10 px-4 py-3 text-sm"
    >
      <span aria-hidden className="mt-0.5 select-none text-warn">
        ⚠
      </span>
      <div className="flex-1">
        <p className="font-medium text-fg-primary">{heading}</p>
        <p className="mt-1 text-fg-secondary">
          Could not clone: {failedNames.join(", ")}. Check your network, then
          restart the daemon to retry, or register the repo manually.
        </p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="text-fg-tertiary hover:text-fg-primary transition-colors"
      >
        ×
      </button>
    </div>
  );
}
