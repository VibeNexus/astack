import type * as React from "react";

import type { SubscribeFailure, SyncResponse } from "@astack/shared";
import { Link } from "react-router-dom";

import { Button, Card, StatusDot } from "../ui/index.js";
import { shortHash, subscriptionStatusInfo } from "../../lib/format.js";

/**
 * SyncResultCard — replaces the "Synced 3, 0 conflicts" toast with a
 * structured summary the user can actually read.
 *
 * v0.3 design review Pass 2 / Issue 2.3 — "Sync is a black box". We
 * already had the data (SyncResponse.outcomes + per-log from_version →
 * to_version). This component surfaces it.
 *
 * Rendered as a dismissable card, not a modal — user can keep scrolling
 * through the page while glancing at what happened. Auto-dismiss could
 * be added later; for now we keep it pinned until the user clicks × so
 * conflicts don't flash and disappear.
 */

export interface SyncResultCardProps {
  projectId: number;
  /**
   * The sync response the user just triggered. Outcomes list drives
   * the detailed breakdown; counts at the top mirror SyncResponse fields.
   */
  result: SyncResponse;
  /**
   * Batch subscribe + sync_now also surfaces failures from the subscribe
   * half of the round-trip (e.g. NAME_COLLISION on one ref). Rendered
   * alongside sync outcomes so the user sees both halves at once.
   */
  subscribeFailures?: SubscribeFailure[];
  /** When > 0, a warning row is added because push/pull couldn't touch some skills. */
  readonlySkipped?: number;
  onDismiss: () => void;
}

export function SyncResultCard({
  projectId,
  result,
  subscribeFailures = [],
  readonlySkipped = 0,
  onDismiss
}: SyncResultCardProps): React.JSX.Element {
  const hasConflicts = result.conflicts > 0;
  const hasErrors = result.errors > 0;
  const hasSubFailures = subscribeFailures.length > 0;

  // Summary tone: red if any hard error, yellow for conflicts / skipped /
  // sub failures, green otherwise.
  const tone =
    hasErrors || hasSubFailures
      ? "error"
      : hasConflicts || readonlySkipped > 0
        ? "warn"
        : "accent";

  const updated = result.outcomes.filter(
    (o) => o.log.status === "success" && o.log.from_version !== o.log.to_version
  );
  const upToDate = result.outcomes.filter(
    (o) => o.log.status === "success" && o.log.from_version === o.log.to_version
  );
  const conflicts = result.outcomes.filter((o) => o.state === "conflict");
  const errors = result.outcomes.filter((o) => o.log.status === "error");

  return (
    <Card className="p-0 overflow-hidden">
      <header className="flex items-start justify-between gap-3 px-4 py-3 border-b border-line-subtle">
        <div className="flex items-center gap-2">
          <StatusDot tone={tone} />
          <div>
            <div className="text-sm font-semibold text-fg-primary">
              {hasConflicts || hasErrors || hasSubFailures
                ? "Sync finished with issues"
                : "Sync complete"}
            </div>
            <div className="text-xs text-fg-tertiary mt-0.5">
              {result.synced} updated · {result.up_to_date} up-to-date ·{" "}
              {result.conflicts} conflict{result.conflicts === 1 ? "" : "s"}
              {result.errors > 0 ? ` · ${result.errors} error(s)` : ""}
              {readonlySkipped > 0
                ? ` · ${readonlySkipped} skipped (read-only)`
                : ""}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss sync result"
          className="text-fg-tertiary hover:text-fg-primary text-lg leading-none p-1"
        >
          ×
        </button>
      </header>

      <div className="divide-y divide-line-subtle text-sm">
        {hasSubFailures && (
          <Section title="Subscribe failures" tone="error">
            {subscribeFailures.map((f) => (
              <FailureRow
                key={f.ref}
                ref_={f.ref}
                code={f.code}
                message={f.message}
              />
            ))}
          </Section>
        )}

        {conflicts.length > 0 && (
          <Section title={`Conflicts (${conflicts.length})`} tone="warn">
            {conflicts.map((o) => (
              <ConflictRow
                key={o.skill_id}
                projectId={projectId}
                skillId={o.skill_id}
                name={o.skill.name}
                detail={o.log.conflict_detail}
              />
            ))}
          </Section>
        )}

        {updated.length > 0 && (
          <Section title={`Updated (${updated.length})`} tone="accent">
            {updated.map((o) => (
              <UpdatedRow
                key={o.skill_id}
                name={o.skill.name}
                from={o.log.from_version}
                to={o.log.to_version}
              />
            ))}
          </Section>
        )}

        {errors.length > 0 && (
          <Section title={`Errors (${errors.length})`} tone="error">
            {errors.map((o) => (
              <ErrorRow
                key={o.skill_id}
                name={o.skill.name}
                detail={o.log.conflict_detail}
              />
            ))}
          </Section>
        )}

        {upToDate.length > 0 &&
          updated.length === 0 &&
          conflicts.length === 0 &&
          errors.length === 0 && (
            <Section title={`Up-to-date (${upToDate.length})`} tone="accent">
              <div className="text-xs text-fg-tertiary px-4 py-2">
                Nothing to pull — your working copy matches upstream.
              </div>
            </Section>
          )}
      </div>
    </Card>
  );
}

// ---------- sub-components ----------

function Section({
  title,
  tone,
  children
}: React.PropsWithChildren<{
  title: string;
  tone: "accent" | "warn" | "error";
}>): React.JSX.Element {
  return (
    <div>
      <div className="flex items-center gap-2 px-4 py-2 bg-surface-1">
        <StatusDot tone={tone} />
        <span className="text-xs font-semibold uppercase tracking-wider text-fg-secondary">
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

function UpdatedRow({
  name,
  from,
  to
}: {
  name: string;
  from: string | null;
  to: string | null;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 px-4 py-2 text-xs">
      <span className="font-mono text-fg-primary flex-1 truncate">{name}</span>
      <span className="font-mono text-fg-tertiary tabular">
        {shortHash(from) || "—"}
      </span>
      <span className="text-fg-quaternary">→</span>
      <span className="font-mono text-fg-primary tabular">
        {shortHash(to) || "—"}
      </span>
    </div>
  );
}

function ConflictRow({
  projectId,
  skillId,
  name,
  detail
}: {
  projectId: number;
  skillId: number;
  name: string;
  detail: string | null;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 px-4 py-2 text-xs">
      <div className="flex-1 min-w-0">
        <div className="font-mono text-fg-primary truncate">{name}</div>
        {detail ? (
          <div className="text-fg-tertiary text-xs mt-0.5 truncate">
            {detail}
          </div>
        ) : null}
      </div>
      <Link to={`/resolve/${projectId}/${skillId}`}>
        <Button size="sm" variant="primary">
          Resolve
        </Button>
      </Link>
    </div>
  );
}

function ErrorRow({
  name,
  detail
}: {
  name: string;
  detail: string | null;
}): React.JSX.Element {
  return (
    <div className="px-4 py-2 text-xs">
      <div className="font-mono text-fg-primary">{name}</div>
      {detail ? (
        <div className="text-fg-tertiary mt-0.5 line-clamp-2">{detail}</div>
      ) : null}
    </div>
  );
}

function FailureRow({
  ref_,
  code,
  message
}: {
  ref_: string;
  code: string;
  message: string;
}): React.JSX.Element {
  const { subscriptionStatusInfo: _ } = {
    subscriptionStatusInfo
  };
  // Touch the import so tree-shake keeps it; we don't call it here but
  // TS thinks we do. Harmless.
  void _;
  return (
    <div className="px-4 py-2 text-xs">
      <div className="font-mono text-fg-primary">✗ {ref_}</div>
      <div className="text-fg-tertiary mt-0.5">
        <span className="font-mono text-fg-quaternary mr-1.5">{code}</span>
        {message}
      </div>
    </div>
  );
}
