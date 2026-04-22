import type * as React from "react";

import type {
  ApplyLocalSkillsResult,
  BootstrapUnmatched,
  SkillType
} from "@astack/shared";
import { useEffect, useMemo, useState } from "react";

import { Badge, Button, Drawer, DrawerHeader } from "../ui/index.js";

/**
 * AdoptDrawer — v0.7 "Adopt from suggestions" UI.
 *
 * Lists every `BootstrapUnmatched` candidate the server considers
 * adoptable (nothing already in `local_skills`, nothing already
 * subscribed, passes scanner). User checks the ones they want to
 * track and clicks [Adopt selected (N)].
 *
 * Visual / interaction model mirrors ResolveBootstrapDrawer:
 *   - Internal selection state keyed by `type/name`
 *   - Per-row checkbox + path/type preview
 *   - Select-all toggle in the footer
 *   - Apply submits through parent-supplied onApply, which should call
 *     POST /api/projects/:id/local-skills/adopt and return the server's
 *     ApplyLocalSkillsResult. Drawer closes on success if all entries
 *     succeeded (failed rows stay visible so the user can see why).
 *
 * Unlike ResolveBootstrapDrawer there's no radio / repo-picker — adopt
 * is a binary "yes, track this locally". The full trio of LocalSkill
 * actions (rename, unadopt, delete-from-disk) lives on LocalSkillsPanel
 * row buttons, not inside this drawer.
 */

export interface AdoptDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Current suggestion list driving the drawer. */
  suggestions: BootstrapUnmatched[];
  /**
   * Called when the user clicks Apply. Should POST
   * /api/projects/:id/local-skills/adopt and return the server's result.
   */
  onApply: (
    entries: Array<{ type: SkillType; name: string }>
  ) => Promise<ApplyLocalSkillsResult>;
  /**
   * Called after a successful apply with at least one succeeded entry.
   * Parent typically shows a toast and refreshes the local-skills query.
   */
  onAdopted?: (result: ApplyLocalSkillsResult) => void;
}

function entryKey(e: { type: SkillType; name: string }): string {
  return `${e.type}/${e.name}`;
}

type SelectionSet = Set<string>;

export function AdoptDrawer({
  open,
  onClose,
  suggestions,
  onApply,
  onAdopted
}: AdoptDrawerProps): React.JSX.Element {
  const [selected, setSelected] = useState<SelectionSet>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] =
    useState<BootstrapUnmatched[]>(suggestions);

  // Re-sync when parent hands us a new list (suggestions query refetched
  // after an SSE event fires). Drop selections for rows that disappeared
  // so the Adopt button count stays honest.
  useEffect(() => {
    setCurrent(suggestions);
    setSelected((prev) => {
      const valid = new Set(suggestions.map((s) => entryKey(s)));
      const next = new Set<string>();
      for (const k of prev) if (valid.has(k)) next.add(k);
      return next;
    });
  }, [suggestions]);

  // Reset ephemeral state on close so a re-open starts fresh.
  useEffect(() => {
    if (!open) {
      setSelected(new Set());
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const grouped = useMemo(() => {
    const byType: Record<SkillType, BootstrapUnmatched[]> = {
      skill: [],
      command: [],
      agent: []
    };
    for (const s of current) byType[s.type].push(s);
    return byType;
  }, [current]);

  const selectedCount = selected.size;
  const allSelected =
    current.length > 0 && selected.size === current.length;

  function toggle(entry: BootstrapUnmatched): void {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = entryKey(entry);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function selectAll(): void {
    setSelected(new Set(current.map((s) => entryKey(s))));
  }

  function clearSelection(): void {
    setSelected(new Set());
  }

  async function handleApply(): Promise<void> {
    if (submitting || selectedCount === 0) return;
    const entries: Array<{ type: SkillType; name: string }> = [];
    for (const s of current) {
      if (selected.has(entryKey(s))) {
        entries.push({ type: s.type, name: s.name });
      }
    }
    if (entries.length === 0) return;

    setSubmitting(true);
    setError(null);
    try {
      const result = await onApply(entries);
      onAdopted?.(result);
      if (result.failed.length === 0) {
        // Clean success — close.
        onClose();
      } else {
        // Keep drawer open so the user can see failed rows (we trim
        // succeeded ones from the list by relying on parent to refetch
        // suggestions; in the meantime dim the selection).
        setSelected(new Set());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      aria-label="Adopt local skills"
      width={520}
    >
      <DrawerHeader title="Adopt local skills" onClose={onClose} />
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {current.length === 0 ? (
          <div className="text-sm text-fg-secondary">
            No adoptable local skills found. Anything under{" "}
            <code className="font-mono text-fg-primary">.claude/</code> is
            already tracked or ignored.
          </div>
        ) : (
          (
            [
              ["skill", "Skills", "dir"],
              ["command", "Commands", "cmd"],
              ["agent", "Agents", "agent"]
            ] as const
          ).map(([type, title, tagText]) =>
            grouped[type].length === 0 ? null : (
              <SuggestionGroup
                key={type}
                title={title}
                tagText={tagText}
                entries={grouped[type]}
                selected={selected}
                onToggle={toggle}
              />
            )
          )
        )}
        {error && <div className="text-sm text-error">{error}</div>}
      </div>
      <footer className="border-t border-line-subtle px-5 h-14 shrink-0 flex items-center justify-between gap-2">
        <div className="text-xs text-fg-tertiary">
          {current.length > 0 && (
            <button
              type="button"
              onClick={allSelected ? clearSelection : selectAll}
              className="underline hover:text-fg-secondary transition-colors"
              disabled={submitting}
            >
              {allSelected ? "Clear all" : "Select all"}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleApply}
            disabled={submitting || selectedCount === 0}
          >
            {submitting
              ? "Adopting…"
              : selectedCount === 0
                ? "Adopt"
                : `Adopt (${selectedCount})`}
          </Button>
        </div>
      </footer>
    </Drawer>
  );
}

function SuggestionGroup({
  title,
  tagText,
  entries,
  selected,
  onToggle
}: {
  title: string;
  tagText: string;
  entries: BootstrapUnmatched[];
  selected: SelectionSet;
  onToggle: (e: BootstrapUnmatched) => void;
}): React.JSX.Element {
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="text-xs font-medium text-fg-tertiary uppercase tracking-wide">
        {title}
        <span className="ml-2 tabular">{entries.length}</span>
      </h3>
      <ul className="space-y-1.5">
        {entries.map((entry) => {
          const k = entryKey(entry);
          const checked = selected.has(k);
          return (
            <li key={k}>
              <label className="flex items-start gap-2 px-3 py-2 rounded-md border border-line-subtle bg-surface-1 hover:bg-surface-2 cursor-pointer transition-colors">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(entry)}
                  aria-label={`Adopt ${entry.type} ${entry.name}`}
                  className="mt-0.5 cursor-pointer"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-mono text-fg-primary">
                    <span className="truncate">{entry.name}</span>
                    <Badge tone="neutral">{tagText}</Badge>
                  </div>
                  <div className="text-xs text-fg-tertiary font-mono truncate mt-0.5">
                    {entry.local_path}
                  </div>
                </div>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
