import type * as React from "react";
import { useState } from "react";

import type {
  ApplyResolutionsResult,
  BootstrapResolution,
  GetProjectStatusResponse,
  ProjectBootstrapResult
} from "@astack/shared";

import { Card } from "../ui/index.js";
import { BootstrapBanner } from "./BootstrapBanner.js";
import { ResolveBootstrapDrawer } from "./ResolveBootstrapDrawer.js";
import { SubscriptionRow } from "./SubscriptionRow.js";

/**
 * Subscriptions tab body.
 *
 * Renders three independent UI concerns:
 *   1. Header (count, [Re-scan local], [+ Add subscription])
 *   2. BootstrapBanner (v0.5) when ambiguous local skills exist
 *   3. The subscriptions table — or one of two empty-state variants:
 *      - legacy: "Subscribe to your first skill" (unchanged)
 *      - v0.5: "N local skills found but not in any registered repo"
 *        when bootstrap.unmatched has items and user has no subs yet
 *
 * The drawer state is local to this panel so the page-level component
 * doesn't need to thread open/close — it just passes `bootstrap` in.
 */

export interface SubscriptionsPanelProps {
  status: GetProjectStatusResponse;
  /** v0.5 bootstrap scan result — null while the first fetch is pending. */
  bootstrap: ProjectBootstrapResult | null;
  projectId: number;
  onUnsubscribe: (skillId: number) => void | Promise<void>;
  /**
   * Triggered by [Re-scan local]. Parent should POST /bootstrap/scan and
   * refresh both status + bootstrap.
   */
  onRescan?: () => void | Promise<void>;
  /**
   * Submits a resolutions batch to the server and returns the result.
   * Drawer uses the returned `remaining_ambiguous` as the sole source of
   * truth for what to show next.
   */
  onBootstrapResolve?: (
    resolutions: BootstrapResolution[]
  ) => Promise<ApplyResolutionsResult>;
  /** Opens the BrowseSkillsDrawer in the parent. */
  onBrowse: () => void;
  /**
   * Bulk-resolve all conflict subscriptions via use-remote strategy.
   * Parent should call POST /resolve-batch and refresh status.
   */
  onResolveAllConflicts?: (skillIds: number[]) => Promise<void>;
}

export function SubscriptionsPanel({
  status,
  bootstrap,
  projectId,
  onUnsubscribe,
  onRescan,
  onBootstrapResolve,
  onBrowse,
  onResolveAllConflicts
}: SubscriptionsPanelProps): React.JSX.Element {
  const [resolveOpen, setResolveOpen] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [resolvingAll, setResolvingAll] = useState(false);
  const subscriptions = status.subscriptions;
  const ambiguous = bootstrap?.ambiguous ?? [];
  const unmatched = bootstrap?.unmatched ?? [];

  const conflictSkillIds = subscriptions
    .filter((s) => s.state === "conflict")
    .map((s) => s.skill.id);

  async function handleRescan(): Promise<void> {
    if (!onRescan || rescanning) return;
    setRescanning(true);
    try {
      await onRescan();
    } finally {
      setRescanning(false);
    }
  }

  async function handleResolveAll(): Promise<void> {
    if (!onResolveAllConflicts || resolvingAll || conflictSkillIds.length === 0) return;
    setResolvingAll(true);
    try {
      await onResolveAllConflicts(conflictSkillIds);
    } finally {
      setResolvingAll(false);
    }
  }

  return (
    <section className="space-y-3 pt-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-fg-secondary">
          Subscriptions
          <span className="ml-2 text-xs text-fg-tertiary tabular">
            {subscriptions.length}
          </span>
        </h2>
        <div className="flex items-center gap-2">
          {onResolveAllConflicts && conflictSkillIds.length > 0 && (
            <button
              type="button"
              onClick={handleResolveAll}
              disabled={resolvingAll}
              className="h-8 px-3 text-sm inline-flex items-center gap-1.5 rounded-md border border-line-subtle text-warn hover:text-fg-primary hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent/60 transition-colors duration-fast disabled:opacity-50 disabled:cursor-not-allowed"
              title={`Resolve ${conflictSkillIds.length} conflict${conflictSkillIds.length === 1 ? "" : "s"} using upstream version`}
            >
              {resolvingAll
                ? "Resolving…"
                : `Use remote (${conflictSkillIds.length})`}
            </button>
          )}
          {onRescan && (
            <button
              type="button"
              onClick={handleRescan}
              disabled={rescanning}
              className="h-8 px-3 text-sm inline-flex items-center gap-1.5 rounded-md border border-line-subtle text-fg-secondary hover:text-fg-primary hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent/60 transition-colors duration-fast disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {rescanning ? "Re-scanning…" : "Re-scan local"}
            </button>
          )}
          <button
            type="button"
            onClick={onBrowse}
            className="h-8 px-3 text-sm inline-flex items-center gap-1.5 rounded-md bg-accent text-accent-fg hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60 transition-colors duration-fast"
          >
            + Add subscription
          </button>
        </div>
      </div>

      {ambiguous.length > 0 && (
        <BootstrapBanner
          ambiguousCount={ambiguous.length}
          onResolve={() => setResolveOpen(true)}
        />
      )}

      {subscriptions.length === 0 ? (
        unmatched.length > 0 ? (
          <UnmatchedEmptyState
            count={unmatched.length}
            onBrowse={onBrowse}
          />
        ) : (
          <EmptyState onBrowse={onBrowse} />
        )
      ) : (
        <Card className="p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-fg-tertiary text-xs">
                <th className="font-normal px-3 py-2 w-[140px]">State</th>
                <th className="font-normal px-3 py-2">Skill</th>
                <th className="font-normal px-3 py-2 w-[224px]">Repo</th>
                <th className="font-normal px-3 py-2 w-[96px]">Version</th>
                <th className="font-normal px-3 py-2 w-[128px]" />
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((s) => (
                <SubscriptionRow
                  key={s.skill.id}
                  row={s}
                  projectId={projectId}
                  onUnsubscribe={onUnsubscribe}
                />
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {onBootstrapResolve && (
        <ResolveBootstrapDrawer
          open={resolveOpen}
          onClose={() => setResolveOpen(false)}
          ambiguous={ambiguous}
          onApply={onBootstrapResolve}
        />
      )}
    </section>
  );
}

/**
 * Empty-state card — the v0.3 "first-run delight" moment.
 */
function EmptyState({ onBrowse }: { onBrowse: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-col items-start gap-4 py-10 px-6 border border-dashed border-line-subtle rounded-lg">
      <div>
        <div className="text-base font-semibold text-fg-primary">
          Subscribe to your first skill
        </div>
        <div className="text-sm text-fg-secondary mt-1 max-w-md">
          Browse skills, commands, and agents from your registered repos.
          Subscribe with one click; we'll sync them to your project's
          <span className="font-mono text-fg-primary"> .claude/</span> directory.
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBrowse}
          className="h-8 px-3 text-sm inline-flex items-center gap-1.5 rounded-md bg-accent text-accent-fg hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60 transition-colors duration-fast"
        >
          Browse skills
        </button>
        <span className="text-xs text-fg-tertiary">
          or run{" "}
          <code className="font-mono text-fg-secondary">
            astack subscribe &lt;skill&gt;
          </code>
        </span>
      </div>
    </div>
  );
}

/**
 * v0.5 empty-state variant: the user has local .claude/ content that
 * doesn't correspond to any registered repo. Nudge them to register
 * the repo rather than presenting the empty "first-run" illusion.
 */
function UnmatchedEmptyState({
  count,
  onBrowse
}: {
  count: number;
  onBrowse: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-start gap-4 py-8 px-6 border border-dashed border-line-subtle rounded-lg">
      <div>
        <div className="text-base font-semibold text-fg-primary">
          {count} local skill{count === 1 ? "" : "s"} found but not in any
          registered repo
        </div>
        <div className="text-sm text-fg-secondary mt-1 max-w-md">
          These live under <code className="font-mono">.claude/</code> in your
          project but aren&apos;t published to any repo astack knows about.
          Register the repo they came from to take them over, or keep them as
          purely local skills.
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBrowse}
          className="h-8 px-3 text-sm inline-flex items-center gap-1.5 rounded-md bg-accent text-accent-fg hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60 transition-colors duration-fast"
        >
          Browse repos
        </button>
      </div>
    </div>
  );
}
