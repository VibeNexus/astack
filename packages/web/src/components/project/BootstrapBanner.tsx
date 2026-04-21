import type * as React from "react";

/**
 * BootstrapBanner — shown at the top of the Subscriptions tab when the
 * v0.5 bootstrap scan found ambiguous local skills (local (type, name)
 * matched by >1 registered repo).
 *
 * Purely presentational: the caller (SubscriptionsPanel) decides
 * visibility and wires `onResolve` to open the ResolveBootstrapDrawer.
 */

export interface BootstrapBannerProps {
  ambiguousCount: number;
  onResolve: () => void;
}

export function BootstrapBanner({
  ambiguousCount,
  onResolve
}: BootstrapBannerProps): React.JSX.Element | null {
  if (ambiguousCount <= 0) return null;

  const plural = ambiguousCount === 1 ? "" : "s";
  const needs = ambiguousCount === 1 ? "needs" : "need";
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-4 mb-4">
      <div className="flex items-start gap-3">
        <WarningIcon />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-fg-primary">
            {ambiguousCount} local skill{plural} {needs} your attention
          </div>
          <div className="text-sm text-fg-secondary mt-1 max-w-xl">
            We found skills in your <code className="font-mono">.claude/</code>{" "}
            that match multiple registered repos. Pick which repo each one
            should subscribe to.
          </div>
          <div className="flex gap-2 mt-3">
            <button
              type="button"
              onClick={onResolve}
              className="h-8 px-3 text-sm inline-flex items-center gap-1.5 rounded-md bg-accent text-accent-fg hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60 transition-colors duration-fast"
            >
              Resolve ({ambiguousCount})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WarningIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className="text-amber-500 mt-0.5 shrink-0"
    >
      <path
        d="M8 1.5L1 14h14L8 1.5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M8 6v4M8 12v.01"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
