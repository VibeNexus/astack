import type * as React from "react";

import type { BootstrapAmbiguous } from "@astack/shared";

/**
 * BootstrapBanner — shown at the top of the Subscriptions tab when the
 * v0.5 bootstrap scan found ambiguous local skills (local (type, name)
 * matched by >1 registered repo).
 *
 * v0.6 UX fix (v0.7 review feedback): the banner used to say
 *   "1 local skill needs your attention" + [Resolve (1)]
 * which visually collided with per-row `Conflict` + [Resolve] buttons in
 * the subscriptions table — users couldn't tell whether the banner's
 * Resolve referred to the conflicted subscription or to a wholly
 * different bootstrap-level ambiguity. We now:
 *   1. Title the banner "Ambiguous local skill(s)" (no "Resolve" word)
 *   2. List the first few ambiguous names inline so the user sees
 *      immediately that the banner is about different skills than the
 *      table rows
 *   3. Label the button "Pick repo" — distinct verb, no overlap with
 *      conflict-resolution.
 *
 * Purely presentational: the caller (SubscriptionsPanel) decides
 * visibility and wires `onResolve` to open the ResolveBootstrapDrawer.
 */

export interface BootstrapBannerProps {
  /**
   * The actual ambiguous entries — used to render their names inline so
   * users see which skills the banner is about (avoids confusion with
   * per-row Conflict rows that share the same "Resolve" verb).
   */
  ambiguous: readonly BootstrapAmbiguous[];
  onResolve: () => void;
}

/** Cap on inline names; anything beyond this collapses to "+N more". */
const INLINE_NAME_CAP = 3;

export function BootstrapBanner({
  ambiguous,
  onResolve
}: BootstrapBannerProps): React.JSX.Element | null {
  const count = ambiguous.length;
  if (count <= 0) return null;

  const plural = count === 1 ? "" : "s";
  const shown = ambiguous.slice(0, INLINE_NAME_CAP);
  const overflow = count - shown.length;

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-4 mb-4">
      <div className="flex items-start gap-3">
        <WarningIcon />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-fg-primary">
            {count} ambiguous local skill{plural}
          </div>
          <div className="text-sm text-fg-secondary mt-1 max-w-xl">
            These live under <code className="font-mono">.claude/</code> and
            match more than one registered repo. Pick which repo each one
            should subscribe to — this is separate from conflicts in the
            subscriptions table below.
          </div>
          <div className="mt-2 text-xs text-fg-tertiary flex flex-wrap items-center gap-1.5">
            {shown.map((a, i) => (
              <span
                key={`${a.type}/${a.name}`}
                className="inline-flex items-center"
              >
                <code className="font-mono text-fg-secondary">{a.name}</code>
                <span className="ml-1 text-fg-tertiary">({a.type})</span>
                {i < shown.length - 1 ? <span className="ml-1">,</span> : null}
              </span>
            ))}
            {overflow > 0 && (
              <span className="text-fg-tertiary">+{overflow} more</span>
            )}
          </div>
          <div className="flex gap-2 mt-3">
            <button
              type="button"
              onClick={onResolve}
              className="h-8 px-3 text-sm inline-flex items-center gap-1.5 rounded-md bg-accent text-accent-fg hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60 transition-colors duration-fast"
            >
              Pick repo ({count})
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
