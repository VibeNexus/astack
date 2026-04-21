import type * as React from "react";

import type {
  ApplyResolutionsResult,
  BootstrapAmbiguous,
  BootstrapResolution,
  SkillType
} from "@astack/shared";
import { useEffect, useMemo, useState } from "react";

import { Button, Drawer, DrawerHeader } from "../ui/index.js";

/**
 * ResolveBootstrapDrawer — v0.5 resolve-ambiguous UI.
 *
 * Shows every ambiguous (type, name) and its candidate repos. User picks
 * one radio per row (or "Don't subscribe (keep local)"). Apply submits
 * only the rows with a selection. Rows without a selection stay in the
 * drawer for later.
 *
 * On successful apply the drawer re-renders from `result.remaining_ambiguous`
 * (the single canonical source of truth per spec §A4) — entries that
 * succeeded disappear, entries that failed stick around.
 */

export interface ResolveBootstrapDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Current ambiguous list driving the drawer. */
  ambiguous: BootstrapAmbiguous[];
  /**
   * Called when the user clicks Apply. Should POST /bootstrap/resolve
   * and return the server's ApplyResolutionsResult.
   */
  onApply: (
    resolutions: BootstrapResolution[]
  ) => Promise<ApplyResolutionsResult>;
  /**
   * Called after a successful apply finishes; parent typically shows a
   * toast ("All set") and decides whether to close the drawer. We close
   * ourselves when `remaining_ambiguous` hits zero.
   */
  onAllResolved?: () => void;
}

/** Sentinel selection value representing "Don't subscribe". */
const DONT_SUBSCRIBE = "none";

type SelectionMap = Map<string, number | typeof DONT_SUBSCRIBE>;

function entryKey(e: { type: SkillType; name: string }): string {
  return `${e.type}/${e.name}`;
}

export function ResolveBootstrapDrawer({
  open,
  onClose,
  ambiguous,
  onApply,
  onAllResolved
}: ResolveBootstrapDrawerProps): React.JSX.Element {
  const [selections, setSelections] = useState<SelectionMap>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentAmbiguous, setCurrentAmbiguous] =
    useState<BootstrapAmbiguous[]>(ambiguous);

  // Re-sync internal list when the caller passes a new ambiguous prop
  // (e.g. an SSE-driven refetch reshuffles the drawer while it's closed).
  useEffect(() => {
    setCurrentAmbiguous(ambiguous);
    // Drop selections for rows that disappeared.
    setSelections((prev) => {
      const keys = new Set(ambiguous.map((a) => entryKey(a)));
      const next = new Map(prev);
      for (const k of next.keys()) {
        if (!keys.has(k)) next.delete(k);
      }
      return next;
    });
  }, [ambiguous]);

  // Clear state when drawer closes so re-open starts fresh.
  useEffect(() => {
    if (!open) {
      setSelections(new Map());
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const selectedCount = selections.size;
  const canApply = selectedCount > 0 && !submitting;

  function setSelection(
    entry: BootstrapAmbiguous,
    value: number | typeof DONT_SUBSCRIBE
  ): void {
    setSelections((prev) => {
      const next = new Map(prev);
      next.set(entryKey(entry), value);
      return next;
    });
  }

  async function handleApply(): Promise<void> {
    if (!canApply) return;
    const resolutions: BootstrapResolution[] = [];
    for (const a of currentAmbiguous) {
      const v = selections.get(entryKey(a));
      if (v === undefined) continue;
      resolutions.push({
        type: a.type,
        name: a.name,
        repo_id: v === DONT_SUBSCRIBE ? null : v
      });
    }
    if (resolutions.length === 0) return;

    setSubmitting(true);
    setError(null);
    try {
      const result = await onApply(resolutions);
      // Rebuild drawer from server truth.
      setCurrentAmbiguous(result.remaining_ambiguous);
      setSelections(new Map());
      if (result.remaining_ambiguous.length === 0) {
        onAllResolved?.();
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const totalLabel = useMemo(() => {
    if (selectedCount === 0) return "Apply";
    return `Apply (${selectedCount})`;
  }, [selectedCount]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      aria-label="Resolve ambiguous local skills"
      width={520}
    >
      <DrawerHeader title="Resolve ambiguous local skills" onClose={onClose} />
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {currentAmbiguous.length === 0 ? (
          <div className="text-sm text-fg-secondary">
            Nothing left to resolve — all local skills are either subscribed
            or explicitly ignored.
          </div>
        ) : (
          currentAmbiguous.map((entry) => (
            <AmbiguousEntryCard
              key={entryKey(entry)}
              entry={entry}
              selected={selections.get(entryKey(entry))}
              onSelect={(value) => setSelection(entry, value)}
            />
          ))
        )}
        {error && (
          <div className="text-sm text-error">{error}</div>
        )}
      </div>
      <footer className="border-t border-line-subtle px-5 h-14 shrink-0 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleApply}
          disabled={!canApply}
        >
          {submitting ? "Applying…" : totalLabel}
        </Button>
      </footer>
    </Drawer>
  );
}

function AmbiguousEntryCard({
  entry,
  selected,
  onSelect
}: {
  entry: BootstrapAmbiguous;
  selected: number | typeof DONT_SUBSCRIBE | undefined;
  onSelect: (value: number | typeof DONT_SUBSCRIBE) => void;
}): React.JSX.Element {
  const name = `ambiguous-${entry.type}-${entry.name}`;
  return (
    <div className="rounded-md border border-line-subtle bg-surface-1 px-4 py-3 space-y-2">
      <div className="text-sm font-medium text-fg-primary">
        <span className="text-fg-tertiary">{entry.type} · </span>
        {entry.name}
      </div>
      <div className="text-xs text-fg-tertiary font-mono">
        Local: {entry.local_path}
      </div>
      <div className="space-y-1.5 pt-1">
        {entry.candidates.map((c) => {
          const isSelected = selected === c.repo.id;
          return (
            <label
              key={c.repo.id}
              className="flex items-center gap-2 text-sm text-fg-primary cursor-pointer"
            >
              <input
                type="radio"
                name={name}
                checked={isSelected}
                onChange={() => onSelect(c.repo.id)}
                className="cursor-pointer"
              />
              <span>
                {c.repo.name}
                {c.repo.head_hash && (
                  <span className="text-xs text-fg-tertiary font-mono ml-2">
                    head {c.repo.head_hash.slice(0, 7)}
                  </span>
                )}
              </span>
            </label>
          );
        })}
        <label className="flex items-center gap-2 text-sm text-fg-primary cursor-pointer">
          <input
            type="radio"
            name={name}
            checked={selected === DONT_SUBSCRIBE}
            onChange={() => onSelect(DONT_SUBSCRIBE)}
            className="cursor-pointer"
          />
          <span className="text-fg-secondary">
            Don&apos;t subscribe (keep local)
          </span>
        </label>
      </div>
    </div>
  );
}
