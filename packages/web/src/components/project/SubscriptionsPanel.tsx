import type * as React from "react";

import type { GetProjectStatusResponse } from "@astack/shared";

import { Card } from "../ui/index.js";
import { SubscriptionRow } from "./SubscriptionRow.js";

/**
 * Subscriptions tab body.
 *
 * Three states:
 *   - empty (0 subs) → starter-pack empty state with CTA
 *   - populated      → table rows (SubscriptionRow each)
 *   - coming in PR7  → Browse drawer opens from the "Add" button
 *
 * The empty state is the v0.3 design review's highest-impact fix — it
 * replaces the "Use the CLI: astack subscribe <skill>" wall of text that
 * was driving first-time users straight out of the web UI.
 */

export interface SubscriptionsPanelProps {
  status: GetProjectStatusResponse;
  projectId: number;
  onUnsubscribe: (skillId: number) => void | Promise<void>;
  /**
   * PR7 will wire this to open the BrowseSkillsDrawer. Until then it's
   * a no-op placeholder so the button can already be laid out.
   */
  onBrowse: () => void;
}

export function SubscriptionsPanel({
  status,
  projectId,
  onUnsubscribe,
  onBrowse
}: SubscriptionsPanelProps): React.JSX.Element {
  const subscriptions = status.subscriptions;

  return (
    <section className="space-y-3 pt-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-fg-secondary">
          Subscriptions
          <span className="ml-2 text-xs text-fg-tertiary tabular">
            {subscriptions.length}
          </span>
        </h2>
        <button
          type="button"
          onClick={onBrowse}
          className="h-8 px-3 text-sm inline-flex items-center gap-1.5 rounded-md bg-accent text-accent-fg hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60 transition-colors duration-fast"
        >
          + Add subscription
        </button>
      </div>

      {subscriptions.length === 0 ? (
        <EmptyState onBrowse={onBrowse} />
      ) : (
        <Card className="p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-fg-tertiary text-xs">
                <th className="font-normal px-3 py-2 w-[140px]">State</th>
                <th className="font-normal px-3 py-2">Skill</th>
                <th className="font-normal px-3 py-2 w-[180px]">Repo</th>
                <th className="font-normal px-3 py-2 w-[96px]">Version</th>
                <th className="font-normal px-3 py-2 w-[120px]" />
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
    </section>
  );
}

/**
 * Empty-state card — the v0.3 "first-run delight" moment.
 *
 * Three things any good empty state does (see plan-design-review):
 *   1. explain what this area is for (one sentence, not a wall)
 *   2. offer the primary next action (here: Browse button)
 *   3. keep CLI-equivalent visible but de-emphasized
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
