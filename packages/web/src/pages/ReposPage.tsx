import type * as React from "react";
/**
 * Repos page — list + register + remove + refresh skill repositories.
 *
 * Each card is expandable: click to load the full skill list (grouped
 * by type: skills / commands / agents). Type counts are derived from
 * the list and memoized per repo.
 */

import type { RepoKind, Skill, SkillRepo } from "@astack/shared";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  Skeleton
} from "../components/ui.js";
import { api, AstackError } from "../lib/api.js";
import { relativeTime, shortHash } from "../lib/format.js";
import { useEventListener } from "../lib/sse.js";
import { useToast } from "../lib/toast.js";

/** Grouped skills for one repo. */
interface RepoSkills {
  loading: boolean;
  skills: Skill[];
  error?: string;
}

export function ReposPage(): React.JSX.Element {
  const [repos, setRepos] = useState<SkillRepo[] | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [skillsByRepo, setSkillsByRepo] = useState<Map<number, RepoSkills>>(
    new Map()
  );
  const [params, setParams] = useSearchParams();
  const showDialog = params.get("action") === "new";
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const { repos: list } = await api.listRepos({ limit: 200 });
      setRepos(list);
    } catch (err) {
      toast.error(
        "Could not load repos",
        err instanceof AstackError ? err.message : String(err)
      );
      setRepos([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Load skills for every repo up front so we can show counts on each card
  // without requiring the user to expand first. The endpoint is cheap
  // (in-memory SELECT) and there are typically <10 repos.
  useEffect(() => {
    if (!repos) return;
    for (const r of repos) {
      // Skip if we already have a state for this repo (avoids re-fetch on
      // every list refresh unless explicitly invalidated).
      if (skillsByRepo.has(r.id)) continue;
      void fetchSkills(r.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos]);

  const fetchSkills = useCallback(
    async (repoId: number): Promise<void> => {
      setSkillsByRepo((prev) => {
        const next = new Map(prev);
        next.set(repoId, { loading: true, skills: [] });
        return next;
      });
      try {
        const { skills } = await api.listRepoSkills(repoId);
        setSkillsByRepo((prev) => {
          const next = new Map(prev);
          next.set(repoId, { loading: false, skills });
          return next;
        });
      } catch (err) {
        setSkillsByRepo((prev) => {
          const next = new Map(prev);
          next.set(repoId, {
            loading: false,
            skills: [],
            error: err instanceof AstackError ? err.message : String(err)
          });
          return next;
        });
      }
    },
    []
  );

  useEventListener("repo.registered", () => void load());
  useEventListener("repo.refreshed", (e) => {
    void load();
    // Re-fetch this repo's skill list so counts update.
    void fetchSkills(e.payload.repo.id);
  });
  useEventListener("repo.removed", (e) => {
    void load();
    setSkillsByRepo((prev) => {
      const next = new Map(prev);
      next.delete(e.payload.repo_id);
      return next;
    });
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete(e.payload.repo_id);
      return next;
    });
  });

  async function handleRefresh(id: number): Promise<void> {
    try {
      const res = await api.refreshRepo(id);
      toast.ok(
        res.changed
          ? `Repo refreshed — HEAD moved`
          : "Repo refreshed — no changes"
      );
      await load();
      void fetchSkills(id);
    } catch (err) {
      toast.error(
        "Refresh failed",
        err instanceof AstackError ? err.message : String(err)
      );
    }
  }

  async function handleDelete(repo: SkillRepo): Promise<void> {
    if (!confirm(`Remove repo "${repo.name}"?`)) return;
    try {
      await api.deleteRepo(repo.id);
      toast.ok(`Removed repo '${repo.name}'`);
      await load();
    } catch (err) {
      toast.error(
        "Delete failed",
        err instanceof AstackError ? err.message : String(err)
      );
    }
  }

  function toggleExpanded(id: number): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Repos</h1>
        <Button
          variant="primary"
          onClick={() => setParams({ action: "new" })}
        >
          Register repo
        </Button>
      </div>

      {repos === null ? (
        <div className="space-y-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : repos.length === 0 ? (
        <EmptyState
          title="No repos registered"
          hint="A skill repo is a git repository with commands/ and skills/ directories."
        >
          <Button
            variant="primary"
            onClick={() => setParams({ action: "new" })}
          >
            Register your first repo
          </Button>
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {repos.map((r) => (
            <RepoCard
              key={r.id}
              repo={r}
              skillsState={skillsByRepo.get(r.id)}
              expanded={expanded.has(r.id)}
              onToggle={() => toggleExpanded(r.id)}
              onRefresh={() => handleRefresh(r.id)}
              onDelete={() => handleDelete(r)}
            />
          ))}
        </div>
      )}

      {showDialog ? (
        <RegisterRepoDialog
          onClose={() => setParams({})}
          onRegistered={() => {
            setParams({});
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

// ---------- RepoCard ----------

interface RepoCardProps {
  repo: SkillRepo;
  skillsState: RepoSkills | undefined;
  expanded: boolean;
  onToggle: () => void;
  onRefresh: () => void;
  onDelete: () => void;
}

function RepoCard({
  repo,
  skillsState,
  expanded,
  onToggle,
  onRefresh,
  onDelete
}: RepoCardProps): React.JSX.Element {
  const counts = countByType(skillsState?.skills ?? []);
  const hasSkills = skillsState && !skillsState.loading && skillsState.skills.length > 0;

  return (
    <Card className="p-0 overflow-hidden hover:border-text-muted/40 transition-colors">
      <div className="flex items-start justify-between gap-3 py-3 px-4">
        <button
          type="button"
          onClick={onToggle}
          className="min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} repo ${repo.name}`}
        >
          <div className="flex items-center gap-2">
            <Chevron open={expanded} />
            <span className="font-medium">{repo.name}</span>
            <Badge tone="neutral">id {repo.id}</Badge>
            {repo.kind === "open-source" ? (
              <Badge tone="warn" title="Pull-only; push will be rejected">
                read-only
              </Badge>
            ) : (
              <Badge tone="accent" title="Two-way sync (pull + push)">
                custom
              </Badge>
            )}
            <CountBadges counts={counts} loading={skillsState?.loading ?? false} />
          </div>
          <div className="text-xs text-text-muted font-mono truncate mt-1">
            {repo.git_url}
          </div>
          <div className="text-xs text-text-muted mt-1 flex items-center gap-3">
            <span>
              HEAD{" "}
              <span className="font-mono">{shortHash(repo.head_hash)}</span>
            </span>
            <span>Last pulled {relativeTime(repo.last_synced)}</span>
          </div>
        </button>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" onClick={onRefresh}>
            Refresh
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDelete}
            className="text-error hover:text-error"
          >
            Remove
          </Button>
        </div>
      </div>

      {expanded ? (
        <div className="border-t border-border bg-base/40 px-4 py-3">
          {skillsState?.loading ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-60" />
              <Skeleton className="h-4 w-48" />
            </div>
          ) : skillsState?.error ? (
            <div className="text-sm text-error">
              Could not load skills: {skillsState.error}
            </div>
          ) : hasSkills ? (
            <SkillList skills={skillsState!.skills} />
          ) : (
            <div className="text-sm text-text-muted">
              No skills scanned from this repo.
            </div>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function Chevron({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      className={`text-text-muted transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path
        d="M4 2l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---------- Counts + skill groups ----------

interface TypeCounts {
  skill: number;
  command: number;
  agent: number;
  total: number;
}

function countByType(skills: readonly Skill[]): TypeCounts {
  const c: TypeCounts = { skill: 0, command: 0, agent: 0, total: skills.length };
  for (const s of skills) {
    if (s.type === "skill") c.skill++;
    else if (s.type === "command") c.command++;
    else if (s.type === "agent") c.agent++;
  }
  return c;
}

function CountBadges({
  counts,
  loading
}: {
  counts: TypeCounts;
  loading: boolean;
}): React.JSX.Element {
  if (loading) {
    return (
      <span className="text-xs text-text-muted tabular ml-2">loading…</span>
    );
  }
  if (counts.total === 0) {
    return (
      <span className="text-xs text-text-muted tabular ml-2">(empty)</span>
    );
  }
  // Inline count display — avoids one badge per zero-count type.
  const parts: string[] = [];
  if (counts.skill > 0) parts.push(`${counts.skill} skill${counts.skill === 1 ? "" : "s"}`);
  if (counts.command > 0)
    parts.push(`${counts.command} command${counts.command === 1 ? "" : "s"}`);
  if (counts.agent > 0)
    parts.push(`${counts.agent} agent${counts.agent === 1 ? "" : "s"}`);
  return (
    <span className="text-xs text-text-secondary tabular ml-2">
      {parts.join(" · ")}
    </span>
  );
}

function SkillList({ skills }: { skills: readonly Skill[] }): React.JSX.Element {
  // Group by type, then alphabetize inside each group.
  const groups: Record<"skill" | "command" | "agent", Skill[]> = {
    skill: [],
    command: [],
    agent: []
  };
  for (const s of skills) {
    groups[s.type as keyof typeof groups]?.push(s);
  }
  for (const key of Object.keys(groups) as (keyof typeof groups)[]) {
    groups[key].sort((a, b) => a.name.localeCompare(b.name));
  }

  return (
    <div className="space-y-3">
      {(["skill", "command", "agent"] as const).map((t) =>
        groups[t].length > 0 ? (
          <SkillGroup key={t} type={t} items={groups[t]} />
        ) : null
      )}
    </div>
  );
}

function SkillGroup({
  type,
  items
}: {
  type: "skill" | "command" | "agent";
  items: readonly Skill[];
}): React.JSX.Element {
  const label =
    type === "skill" ? "Skills" : type === "command" ? "Commands" : "Agents";
  return (
    <div>
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-text-muted mb-1.5">
        <span>{label}</span>
        <span className="tabular">({items.length})</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1">
        {items.map((s) => (
          <div
            key={s.id}
            className="min-w-0"
            title={s.description ?? undefined}
          >
            <span className="font-mono text-sm text-text-primary">{s.name}</span>
            {s.description ? (
              <span className="ml-2 text-xs text-text-muted truncate">
                — {s.description}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Register dialog (unchanged) ----------

function RegisterRepoDialog({
  onClose,
  onRegistered
}: {
  onClose: () => void;
  onRegistered: () => void;
}): React.JSX.Element {
  const [gitUrl, setGitUrl] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<RepoKind>("custom");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function submit(): Promise<void> {
    if (!gitUrl.trim()) return;
    setBusy(true);
    try {
      const res = await api.registerRepo({
        git_url: gitUrl.trim(),
        name: name.trim() || undefined,
        kind
      });
      toast.ok(
        `Registered ${res.repo.name}`,
        `${res.command_count} command(s), ${res.skill_count} skill(s)`
      );
      onRegistered();
    } catch (err) {
      toast.error(
        "Registration failed",
        err instanceof AstackError ? err.message : String(err)
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-30 bg-base/60 flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="w-[520px] max-w-[90vw] bg-elevated border border-border rounded p-4 space-y-3">
        <div className="text-lg font-semibold text-text-primary">Register skill repo</div>

        <label className="block text-sm">
          <div className="text-text-secondary mb-1">Git URL</div>
          <input
            className="w-full bg-surface border border-border rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
            placeholder="git@github.com:me/skills.git"
            value={gitUrl}
            onChange={(e) => setGitUrl(e.target.value)}
            disabled={busy}
            autoFocus
          />
        </label>

        <div className="block text-sm">
          <div className="text-text-secondary mb-1.5">Repo type</div>
          <div className="grid grid-cols-2 gap-2">
            <KindOption
              selected={kind === "custom"}
              onClick={() => !busy && setKind("custom")}
              title="Custom"
              tag="two-way"
              tagTone="accent"
              description="Your own repo. Pull from remote and push local edits back."
            />
            <KindOption
              selected={kind === "open-source"}
              onClick={() => !busy && setKind("open-source")}
              title="Open-source"
              tag="pull-only"
              tagTone="warn"
              description="Third-party repo. Pull only; local edits cannot be pushed upstream."
            />
          </div>
        </div>

        <label className="block text-sm">
          <div className="text-text-secondary mb-1">
            Name <span className="text-text-muted">(optional)</span>
          </div>
          <input
            className="w-full bg-surface border border-border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            placeholder="Derived from URL by default"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || !gitUrl}>
            {busy ? "Cloning…" : "Register"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function KindOption({
  selected,
  onClick,
  title,
  tag,
  tagTone,
  description
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  tag: string;
  tagTone: "accent" | "warn";
  description: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`text-left p-3 rounded border transition-colors ${
        selected
          ? "border-accent bg-accent-muted/20"
          : "border-border bg-surface hover:bg-elevated"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="font-medium text-text-primary">{title}</span>
        <Badge tone={tagTone}>{tag}</Badge>
      </div>
      <div className="text-xs text-text-secondary mt-1.5 leading-snug">
        {description}
      </div>
    </button>
  );
}
