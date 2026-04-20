import type * as React from "react";

import type {
  Skill,
  SkillRepo,
  SubscribeResponse,
  Subscription
} from "@astack/shared";
import { useEffect, useMemo, useState } from "react";

import {
  Badge,
  Button,
  Drawer,
  DrawerHeader,
  Skeleton,
  StatusDot
} from "../ui/index.js";
import { api, AstackError } from "../../lib/api.js";
import { useToast } from "../../lib/toast.js";

/**
 * BrowseSkillsDrawer — the v0.3 centerpiece.
 *
 * Takes the flow from "No subscriptions yet. Use the CLI." → three clicks
 * in the web UI:
 *   1. click "+ Add subscription" (parent wires `open={true}`)
 *   2. pick N skills with checkboxes (search + type filter available)
 *   3. click "Subscribe N" — server subscribes all + initial sync in one
 *      round-trip
 *
 * Data load strategy:
 *   - On open, fetch the repo list (cheap) then fan out one
 *     listRepoSkills per repo in parallel. v0.3 eng review flagged this
 *     as N+1 but local HTTP/2 handles 20 repos in ~50ms — TODO T1 tracks
 *     a proper `GET /api/skills?q=` aggregate for v0.4.
 *   - Skills that are already subscribed appear disabled with a
 *     "subscribed" tag so users never waste a click on them.
 *
 * Failure handling:
 *   - Partial success in the subscribe batch surfaces via the
 *     `subscribeResult.failures` array. Rather than pretending everything
 *     worked or rolling back, we return the result to the parent so the
 *     page can render a SyncResultCard with both the successful subs and
 *     the per-ref failures side-by-side.
 */

export interface BrowseSkillsDrawerProps {
  projectId: number;
  open: boolean;
  onClose: () => void;
  /**
   * Refs the user has ALREADY subscribed to — fed from the project
   * status. Used to disable those rows. Keys are "repo_name/skill_name"
   * which is the canonical disambiguated ref form.
   */
  alreadySubscribed: ReadonlySet<string>;
  /**
   * Called after a successful (even partial) subscribe. Parent decides
   * what to do with the result — typically show a SyncResultCard and
   * reload the project status.
   */
  onSubscribed: (result: SubscribeResponse) => void;
}

type TypeFilter = "all" | "skill" | "command" | "agent";

interface SkillRow {
  skill: Skill;
  repo: SkillRepo;
  /** `${repo.name}/${skill.name}` — unique enough for selection + disabled lookup. */
  ref: string;
  alreadySubscribed: boolean;
}

export function BrowseSkillsDrawer({
  projectId,
  open,
  onClose,
  alreadySubscribed,
  onSubscribed
}: BrowseSkillsDrawerProps): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<SkillRow[]>([]);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  // Load on every open — ensures the drawer reflects fresh repo state if
  // the user registered a new repo since their last visit.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setSelected(new Set());
    setQuery("");
    setTypeFilter("all");

    (async () => {
      try {
        const { repos } = await api.listRepos({ limit: 500 });
        // N+1 is acceptable here — see file header and v0.3 TODO T1.
        const perRepo = await Promise.all(
          repos.map(async (repo) => {
            try {
              const { skills } = await api.listRepoSkills(repo.id);
              return skills.map<SkillRow>((skill) => ({
                skill,
                repo,
                ref: `${repo.name}/${skill.name}`,
                alreadySubscribed: alreadySubscribed.has(
                  `${repo.name}/${skill.name}`
                )
              }));
            } catch {
              // A repo in 'seeding' or 'failed' state returns an error
              // here; skip it silently. The repo still appears as an
              // empty group which is the honest representation.
              return [];
            }
          })
        );
        if (cancelled) return;
        const flat = perRepo.flat();
        // Sort: by repo name, then skill name within repo. Stable output
        // so the list doesn't jitter between opens.
        flat.sort((a, b) => {
          if (a.repo.name !== b.repo.name) {
            return a.repo.name.localeCompare(b.repo.name);
          }
          return a.skill.name.localeCompare(b.skill.name);
        });
        setRows(flat);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setLoadError(
          err instanceof AstackError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err)
        );
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, alreadySubscribed]);

  // ---- derived ----
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (typeFilter !== "all" && r.skill.type !== typeFilter) return false;
      if (!q) return true;
      const hay = [
        r.skill.name,
        r.skill.description ?? "",
        r.repo.name
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, query, typeFilter]);

  // Group rows by repo for visual hierarchy. Repo order comes from the
  // already-sorted `filtered` array — we just detect group boundaries.
  const groups = useMemo(() => {
    const out: Array<{ repo: SkillRepo; rows: SkillRow[] }> = [];
    let currentRepoId: number | null = null;
    for (const r of filtered) {
      if (r.repo.id !== currentRepoId) {
        out.push({ repo: r.repo, rows: [] });
        currentRepoId = r.repo.id;
      }
      out[out.length - 1]!.rows.push(r);
    }
    return out;
  }, [filtered]);

  const selectableCount = filtered.filter((r) => !r.alreadySubscribed).length;
  const allFilteredSelected =
    selectableCount > 0 &&
    filtered.every(
      (r) => r.alreadySubscribed || selected.has(r.ref)
    );

  function toggleOne(ref: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  }

  function toggleAllFiltered(): void {
    setSelected((prev) => {
      const next = new Set(prev);
      const all = filtered
        .filter((r) => !r.alreadySubscribed)
        .map((r) => r.ref);
      if (allFilteredSelected) {
        for (const ref of all) next.delete(ref);
      } else {
        for (const ref of all) next.add(ref);
      }
      return next;
    });
  }

  async function handleSubscribe(): Promise<void> {
    if (selected.size === 0) return;
    setSubmitting(true);
    try {
      const result = await api.subscribe(projectId, {
        skills: Array.from(selected),
        sync_now: true
      });
      // Partial-success contract (v0.3 PR4): we always get a valid response,
      // may contain failures. Parent renders the SyncResultCard.
      onSubscribed(result);
      onClose();
      if (result.failures.length > 0) {
        toast.warn(
          `Subscribed ${result.subscriptions.length}, ${result.failures.length} failed`,
          "See the result card on the project page."
        );
      } else {
        toast.ok(
          `Subscribed ${result.subscriptions.length} skill(s)`,
          "Initial sync complete."
        );
      }
    } catch (err) {
      toast.error(
        "Subscribe failed",
        err instanceof AstackError ? err.message : String(err)
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      aria-label="Browse skills"
      width={720}
    >
      <DrawerHeader title="Browse skills" onClose={onClose} />

      {/* Search + filter toolbar */}
      <div className="px-5 py-3 border-b border-line-subtle space-y-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, description, or repo…"
          className="w-full h-9 px-3 bg-surface-1 border border-line-subtle rounded-md text-sm text-fg-primary placeholder-fg-tertiary focus:outline-none focus:border-accent/60 focus:bg-surface-2"
          aria-label="Search skills"
        />
        <div className="flex items-center gap-2">
          <TypeFilterGroup value={typeFilter} onChange={setTypeFilter} />
          {filtered.length > 0 && (
            <button
              type="button"
              onClick={toggleAllFiltered}
              className="ml-auto text-xs text-fg-secondary hover:text-fg-primary"
            >
              {allFilteredSelected ? "Clear all" : "Select all visible"}
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="p-5 space-y-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : loadError ? (
          <div className="p-5 text-sm text-error">{loadError}</div>
        ) : filtered.length === 0 ? (
          <div className="p-5 text-sm text-fg-secondary">
            {rows.length === 0
              ? "No skills available. Register a repo first: Repos → Register repo."
              : "No skills match the current filters."}
          </div>
        ) : (
          <div>
            {groups.map((g) => (
              <RepoGroup
                key={g.repo.id}
                repo={g.repo}
                rows={g.rows}
                selected={selected}
                onToggle={toggleOne}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer bar */}
      <footer className="border-t border-line-subtle px-5 py-3 flex items-center justify-between shrink-0 bg-surface-1">
        <div className="text-sm text-fg-secondary">
          {selected.size === 0 ? (
            <span className="text-fg-tertiary">Select skills to continue</span>
          ) : (
            <span>
              <span className="font-semibold text-fg-primary tabular">
                {selected.size}
              </span>{" "}
              selected
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubscribe}
            disabled={selected.size === 0 || submitting}
          >
            {submitting
              ? "Subscribing…"
              : `Subscribe ${selected.size > 0 ? selected.size : ""}`}
          </Button>
        </div>
      </footer>
    </Drawer>
  );
}

// ---------- sub-components ----------

function TypeFilterGroup({
  value,
  onChange
}: {
  value: TypeFilter;
  onChange: (t: TypeFilter) => void;
}): React.JSX.Element {
  const options: Array<{ id: TypeFilter; label: string }> = [
    { id: "all", label: "All" },
    { id: "skill", label: "Skills" },
    { id: "command", label: "Commands" },
    { id: "agent", label: "Agents" }
  ];
  return (
    <div
      role="group"
      aria-label="Filter by type"
      className="inline-flex items-center gap-px rounded-md bg-surface-2 p-0.5"
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.id)}
            className={[
              "h-7 px-2.5 text-xs rounded transition-colors duration-fast",
              active
                ? "bg-surface-3 text-fg-primary"
                : "text-fg-secondary hover:text-fg-primary"
            ].join(" ")}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function RepoGroup({
  repo,
  rows,
  selected,
  onToggle
}: {
  repo: SkillRepo;
  rows: SkillRow[];
  selected: Set<string>;
  onToggle: (ref: string) => void;
}): React.JSX.Element {
  return (
    <section className="border-b border-line-subtle last:border-b-0">
      {/* Sticky repo group header.
          - bg-overlay (opaque) so scrolling skill rows don't bleed through.
          - z-10 puts it above the rows underneath; the drawer itself
            owns the stacking context, so 10 is plenty.
          - shadow-[0_1px_0] on the bottom sim-draws the border beneath
            the sticky header, otherwise it detaches when the first row
            scrolls under. */}
      <div className="sticky top-0 z-10 bg-overlay border-b border-line-subtle px-5 py-2.5 flex items-center gap-2 text-xs text-fg-secondary">
        <span className="font-semibold text-fg-primary">{repo.name}</span>
        {repo.kind === "open-source" ? (
          <Badge tone="warn">read-only</Badge>
        ) : null}
        <span className="text-fg-quaternary">·</span>
        <span className="tabular">{rows.length}</span>
      </div>
      <div>
        {rows.map((r) => (
          <SkillOptionRow
            key={r.ref}
            row={r}
            selected={selected.has(r.ref)}
            onToggle={() => onToggle(r.ref)}
          />
        ))}
      </div>
    </section>
  );
}

function SkillOptionRow({
  row,
  selected,
  onToggle
}: {
  row: SkillRow;
  selected: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const disabled = row.alreadySubscribed;
  return (
    <label
      className={[
        "flex items-start gap-3 px-5 py-2.5 cursor-pointer",
        "transition-colors duration-fast",
        disabled
          ? "opacity-50 cursor-not-allowed"
          : "hover:bg-surface-2"
      ].join(" ")}
    >
      <input
        type="checkbox"
        checked={selected}
        disabled={disabled}
        onChange={onToggle}
        className="mt-0.5 accent-accent"
        aria-label={`Select ${row.skill.name}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm">
          <span className="font-mono text-fg-primary truncate">
            {row.skill.name}
          </span>
          {row.skill.type === "skill" ? (
            <Badge tone="neutral">dir</Badge>
          ) : row.skill.type === "agent" ? (
            <Badge tone="neutral">agent</Badge>
          ) : null}
          {disabled ? (
            <span className="ml-1 inline-flex items-center gap-1 text-xs text-fg-tertiary">
              <StatusDot tone="muted" />
              subscribed
            </span>
          ) : null}
        </div>
        {row.skill.description ? (
          <div className="mt-0.5 text-xs text-fg-tertiary line-clamp-2">
            {row.skill.description}
          </div>
        ) : null}
      </div>
    </label>
  );
}

// Create a ref builder that mirrors the one used in `alreadySubscribed`
// set so callers can produce matching keys without peeking at the
// internal row shape. Used by ProjectDetailPage to seed the disabled set.
export function makeSubscribedRefSet(
  subscriptions: ReadonlyArray<{ repo: { name: string }; skill: { name: string } }>
): Set<string> {
  const out = new Set<string>();
  for (const s of subscriptions) {
    out.add(`${s.repo.name}/${s.skill.name}`);
  }
  return out;
}

// Silence unused import warnings if Subscription type changes shape. Keep
// the import to hint that this file's contract is keyed to the response.
void (null as unknown as Subscription);
