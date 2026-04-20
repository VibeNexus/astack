import type * as React from "react";
/**
 * Repos page — Graphite UI v0.3.
 *
 * Card anatomy:
 *   ┌──────────────────────────────────────────────────────┐
 *   │  anthropic-skills                               ⋯    │
 *   │  ○ read-only  ·  17 skills                           │
 *   │                                                      │
 *   │  github.com/anthropics/skills                        │
 *   │  2c7ec5e · synced 2h ago                             │
 *   └──────────────────────────────────────────────────────┘
 *
 *  - Entire card is the expand affordance (click anywhere).
 *  - Actions move into a ⋯ menu (Refresh / Remove) so the card
 *    header stays clean.
 *  - Status shown as dot + inline text, not pills.
 */

import type { RepoKind, Skill, SkillRepo } from "@astack/shared";
import { isBuiltinSeedUrl } from "@astack/shared";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from "react";
import { useSearchParams } from "react-router-dom";

import {
  Button,
  Card,
  EmptyState,
  IconButton,
  InlineTag,
  Skeleton,
  StatusDot
} from "../components/ui.js";
import { api, AstackError } from "../lib/api.js";
import { relativeTime, shortHash } from "../lib/format.js";
import { useEventListener } from "../lib/sse.js";
import { useToast } from "../lib/toast.js";

interface RepoSkillsState {
  loading: boolean;
  skills: Skill[];
  error?: string;
}

export function ReposPage(): React.JSX.Element {
  const [repos, setRepos] = useState<SkillRepo[] | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [skillsByRepo, setSkillsByRepo] = useState<
    Map<number, RepoSkillsState>
  >(new Map());
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

  // Eagerly fetch skill lists so counts are ready on first render.
  useEffect(() => {
    if (!repos) return;
    for (const r of repos) {
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
        res.changed ? "Repo refreshed — HEAD moved" : "Repo up to date"
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
      toast.ok(`Removed ${repo.name}`);
      await load();
    } catch (err) {
      toast.error(
        "Delete failed",
        err instanceof AstackError ? err.message : String(err)
      );
    }
  }

  function toggle(id: number): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-7">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-fg-primary">
            Repos
          </h1>
          <p className="mt-1 text-sm text-fg-secondary">
            Git repositories scanned for commands, skills, and agents.
          </p>
        </div>
        <Button onClick={() => setParams({ action: "new" })}>
          Register repo
        </Button>
      </header>

      {repos === null ? (
        <div className="space-y-2">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : repos.length === 0 ? (
        <EmptyState
          title="No repos yet"
          hint="Register a git repository that contains skills/, commands/, or agents/ directories. Astack clones and scans it."
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
              onToggle={() => toggle(r.id)}
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
  skillsState: RepoSkillsState | undefined;
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
  const hasSkills =
    skillsState && !skillsState.loading && skillsState.skills.length > 0;

  return (
    <Card className="overflow-hidden">
      <div className="relative">
        {/* Clickable area: entire header. Uses a full-size invisible button
            underneath so keyboard users get a proper focus target. */}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${repo.name}`}
          className="absolute inset-0 w-full rounded-lg focus-visible:ring-2 focus-visible:ring-accent/60"
        />

        <div className="relative pointer-events-none flex items-start justify-between gap-4 px-5 py-4">
          {/* Title + metadata column */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <Chevron open={expanded} />
              <span className="text-lg font-semibold text-fg-primary truncate min-w-0">
                {repo.name}
              </span>
              <RepoSourceTag repo={repo} />
            </div>

            <div className="mt-1 ml-[22px] flex items-center gap-3 text-xs text-fg-tertiary">
              {repo.kind === "open-source" ? (
                <InlineTag tone="hollow">read-only</InlineTag>
              ) : (
                <InlineTag tone="accent">two-way sync</InlineTag>
              )}
              <span className="text-fg-quaternary">·</span>
              <SkillCounts counts={counts} loading={skillsState?.loading} />
            </div>

            <div className="mt-3 ml-[22px] text-xs font-mono text-fg-tertiary truncate">
              {stripGitHubPrefix(repo.git_url)}
            </div>
            <div className="mt-0.5 ml-[22px] text-xs text-fg-tertiary tabular flex items-center gap-2">
              <span className="font-mono text-fg-secondary">
                {shortHash(repo.head_hash) || "—"}
              </span>
              <span className="text-fg-quaternary">·</span>
              <span>synced {relativeTime(repo.last_synced)}</span>
            </div>
          </div>

          {/* Actions — pointer-events-auto so they remain clickable over
              the invisible expand button. */}
          <div
            className="pointer-events-auto shrink-0"
            onClick={(e: ReactMouseEvent) => e.stopPropagation()}
          >
            <RepoMenu onRefresh={onRefresh} onDelete={onDelete} />
          </div>
        </div>
      </div>

      {expanded ? (
        <div className="bg-surface-1 hairline px-5 py-5">
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
            <div className="text-sm text-fg-secondary">
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
      aria-hidden
      width="14"
      height="14"
      viewBox="0 0 14 14"
      className={`text-fg-tertiary transition-transform duration-fast ${
        open ? "rotate-90" : ""
      }`}
    >
      <path
        d="M5 3.5L8.5 7L5 10.5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Source-of-origin tag next to the repo title.
 *
 *   - "Built-in"   — one of the seeded repos that astack distributes by
 *                    default (anthropic-skills / gstack / everything-claude-code).
 *                    Matched by URL so it survives rename.
 *   - "Open source"— third-party repo the user registered themselves
 *                    (kind=open-source, not in the seed list).
 *   - (nothing)    — user's own custom repo. Default state, no tag needed.
 *
 * Visual weight is deliberately light: these are labels, not status.
 */
function RepoSourceTag({ repo }: { repo: SkillRepo }): React.JSX.Element | null {
  const isBuiltin = isBuiltinSeedUrl(repo.git_url);
  if (isBuiltin) {
    // Slight accent tint — it's ours.
    return (
      <span
        className="inline-flex items-center h-5 px-1.5 rounded-xs
          text-[11px] font-medium tracking-wide uppercase
          text-accent bg-accent/10 border border-accent/20"
      >
        Built-in
      </span>
    );
  }
  if (repo.kind === "open-source") {
    return (
      <span
        className="inline-flex items-center h-5 px-1.5 rounded-xs
          text-[11px] font-medium tracking-wide uppercase
          text-fg-secondary bg-surface-2 border border-line-subtle"
      >
        Open source
      </span>
    );
  }
  return null;
}

function stripGitHubPrefix(url: string): string {
  // Visual cleanup: users don't need to read the https:// or .git on
  // every row. Keep the full url on hover via the title attr upstream.
  return url
    .replace(/^https?:\/\//, "")
    .replace(/^git@/, "")
    .replace(/\.git$/, "");
}

// ---------- Skill counts + list ----------

interface TypeCounts {
  skill: number;
  command: number;
  agent: number;
  total: number;
}

function countByType(skills: readonly Skill[]): TypeCounts {
  const c: TypeCounts = {
    skill: 0,
    command: 0,
    agent: 0,
    total: skills.length
  };
  for (const s of skills) {
    if (s.type === "skill") c.skill++;
    else if (s.type === "command") c.command++;
    else if (s.type === "agent") c.agent++;
  }
  return c;
}

function SkillCounts({
  counts,
  loading
}: {
  counts: TypeCounts;
  loading: boolean | undefined;
}): React.JSX.Element {
  if (loading) {
    return <span className="text-fg-tertiary tabular">loading…</span>;
  }
  if (counts.total === 0) {
    return <span className="text-fg-tertiary">empty</span>;
  }
  const parts: string[] = [];
  if (counts.skill > 0)
    parts.push(`${counts.skill} skill${counts.skill === 1 ? "" : "s"}`);
  if (counts.command > 0)
    parts.push(`${counts.command} command${counts.command === 1 ? "" : "s"}`);
  if (counts.agent > 0)
    parts.push(`${counts.agent} agent${counts.agent === 1 ? "" : "s"}`);
  return (
    <span className="text-fg-secondary tabular">{parts.join(" · ")}</span>
  );
}

function SkillList({
  skills
}: {
  skills: readonly Skill[];
}): React.JSX.Element {
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

  // Each section tracks its own collapse state independently. All start
  // open so existing behavior is preserved; clicking the header toggles.
  return (
    <div className="space-y-5">
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
  const [open, setOpen] = useState(true);
  const label =
    type === "skill" ? "Skills" : type === "command" ? "Commands" : "Agents";
  const headingId = `skill-group-${type}`;

  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${headingId}-panel`}
        id={headingId}
        onClick={() => setOpen((v) => !v)}
        className="group mb-3 flex items-center gap-2 text-left select-none"
      >
        <Chevron open={open} />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-tertiary group-hover:text-fg-secondary transition-colors">
          {label}
        </h3>
        <span className="text-xs tabular text-fg-quaternary">
          {items.length}
        </span>
      </button>
      {open ? (
        // Two columns gives each skill + description room to breathe.
        // Three-column grid forced descriptions to collide/truncate.
        <div
          id={`${headingId}-panel`}
          role="region"
          aria-labelledby={headingId}
          className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-3.5"
        >
          {items.map((s) => (
            <SkillRow key={s.id} skill={s} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function SkillRow({ skill }: { skill: Skill }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="font-mono text-sm text-fg-primary">{skill.name}</div>
      {skill.description ? (
        <div className="mt-0.5 text-xs text-fg-tertiary leading-snug line-clamp-2">
          {skill.description}
        </div>
      ) : null}
    </div>
  );
}

// ---------- Row menu ----------

function RepoMenu({
  onRefresh,
  onDelete
}: {
  onRefresh: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapRef}>
      <IconButton
        label="Actions"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
          <circle cx="3" cy="7" r="1.2" fill="currentColor" />
          <circle cx="7" cy="7" r="1.2" fill="currentColor" />
          <circle cx="11" cy="7" r="1.2" fill="currentColor" />
        </svg>
      </IconButton>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-9 z-10 min-w-[160px] py-1
            bg-surface-3 border border-line rounded-md shadow-xl shadow-black/30
            backdrop-blur"
        >
          <MenuItem
            onClick={() => {
              setOpen(false);
              onRefresh();
            }}
          >
            Refresh
          </MenuItem>
          <MenuItem
            destructive
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            Remove
          </MenuItem>
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  destructive = false
}: {
  children: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={[
        "w-full text-left px-3 h-7 flex items-center text-sm",
        destructive
          ? "text-error hover:bg-error/10"
          : "text-fg-primary hover:bg-surface-2"
      ].join(" ")}
    >
      {children}
    </button>
  );
}

// ---------- Register dialog (refined) ----------

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
      className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-[520px] max-w-[92vw] rounded-xl border border-line
          bg-[#14171c] shadow-2xl shadow-black/40 p-6 space-y-5"
      >
        <div>
          <div className="text-lg font-semibold text-fg-primary">
            Register skill repo
          </div>
          <div className="mt-1 text-sm text-fg-secondary">
            Astack will clone the repo and scan it for commands, skills, and
            agents.
          </div>
        </div>

        <FieldLabel label="Git URL">
          <input
            className="w-full h-9 px-3 bg-surface-1 border border-line-subtle rounded-md
              text-sm font-mono text-fg-primary placeholder-fg-tertiary
              focus:outline-none focus:border-accent/60 focus:bg-surface-2
              transition-colors"
            placeholder="git@github.com:me/skills.git"
            value={gitUrl}
            onChange={(e) => setGitUrl(e.target.value)}
            disabled={busy}
            autoFocus
          />
        </FieldLabel>

        <FieldLabel label="Repo type">
          <div className="grid grid-cols-2 gap-2">
            <KindOption
              selected={kind === "custom"}
              onClick={() => !busy && setKind("custom")}
              title="Custom"
              subtitle="Two-way sync"
              description="Your own repo. Pull and push edits."
              tone="accent"
            />
            <KindOption
              selected={kind === "open-source"}
              onClick={() => !busy && setKind("open-source")}
              title="Open source"
              subtitle="Read-only"
              description="Third-party. Pull only."
              tone="hollow"
            />
          </div>
        </FieldLabel>

        <FieldLabel
          label="Name"
          hint="Defaults to the last segment of the URL."
        >
          <input
            className="w-full h-9 px-3 bg-surface-1 border border-line-subtle rounded-md
              text-sm text-fg-primary placeholder-fg-tertiary
              focus:outline-none focus:border-accent/60 focus:bg-surface-2
              transition-colors"
            placeholder="Auto-derived"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </FieldLabel>

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

function FieldLabel({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="block">
      <div className="mb-1.5 text-xs font-medium text-fg-secondary">
        {label}
        {hint ? (
          <span className="ml-2 font-normal text-fg-tertiary">{hint}</span>
        ) : null}
      </div>
      {children}
    </label>
  );
}

function KindOption({
  selected,
  onClick,
  title,
  subtitle,
  description,
  tone
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
  description: string;
  tone: "accent" | "hollow";
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={[
        "text-left p-3 rounded-lg border transition-colors duration-fast",
        selected
          ? "border-accent/60 bg-accent-muted"
          : "border-line-subtle bg-surface-1 hover:bg-surface-2 hover:border-line"
      ].join(" ")}
    >
      <div className="flex items-center gap-1.5 text-sm font-medium text-fg-primary">
        <StatusDot tone={tone} />
        {title}
      </div>
      <div className="mt-0.5 text-xs text-fg-tertiary">{subtitle}</div>
      <div className="mt-2 text-xs text-fg-secondary leading-snug">
        {description}
      </div>
    </button>
  );
}
