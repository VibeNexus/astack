/**
 * Status helpers — map enum values to the copy, tone, and symbol used
 * across the dashboard.
 */

import {
  SubscriptionState,
  type SubscriptionState as SubStateT,
  type LinkedDirStatus
} from "@astack/shared";

type Tone = "accent" | "warn" | "error" | "muted";

const SUBSCRIPTION_LABELS: Record<
  SubStateT,
  { label: string; tone: Tone; symbol: string }
> = {
  [SubscriptionState.Synced]: { label: "Synced", tone: "accent", symbol: "✓" },
  [SubscriptionState.Behind]: { label: "Behind", tone: "warn", symbol: "↓" },
  [SubscriptionState.LocalAhead]: {
    label: "Local-ahead",
    tone: "warn",
    symbol: "↑"
  },
  [SubscriptionState.Conflict]: {
    label: "Conflict",
    tone: "error",
    symbol: "⚠"
  },
  [SubscriptionState.Pending]: {
    label: "Pending",
    tone: "muted",
    symbol: "•"
  }
};

export function subscriptionStatusInfo(state: SubStateT): {
  label: string;
  tone: Tone;
  symbol: string;
} {
  return SUBSCRIPTION_LABELS[state];
}

const LINK_LABELS: Record<
  LinkedDirStatus,
  { label: string; tone: Tone }
> = {
  active: { label: "Active", tone: "accent" },
  broken: { label: "Broken", tone: "error" },
  removed: { label: "Removed", tone: "muted" }
};

export function linkedDirStatusInfo(status: LinkedDirStatus): {
  label: string;
  tone: Tone;
} {
  return LINK_LABELS[status];
}

/** Priority sort key for the Sync Status page (errors first). */
export function subscriptionPriority(state: SubStateT): number {
  switch (state) {
    case SubscriptionState.Conflict:
      return 0;
    case SubscriptionState.Behind:
      return 1;
    case SubscriptionState.LocalAhead:
      return 2;
    case SubscriptionState.Pending:
      return 3;
    case SubscriptionState.Synced:
      return 4;
    default:
      return 5;
  }
}

/** Relative time: "3s ago", "2m ago", "1h ago". */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return iso;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Truncate a commit hash to 7 chars. */
export function shortHash(hash: string | null | undefined): string {
  if (!hash) return "—";
  return hash.slice(0, 7);
}
