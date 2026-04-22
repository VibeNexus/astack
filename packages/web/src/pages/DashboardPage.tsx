import type * as React from "react";
/**
 * Dashboard — default workstation page.
 *
 * Shows one row per project with aggregated sync health.
 * Click any row to navigate to the project detail page.
 */

import type { Project, SubscriptionWithState } from "@astack/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { Badge, Button, Card, EmptyState, Skeleton, StatusDot } from "../components/ui/index.js";
import { api, AstackError } from "../lib/api.js";
import { relativeTime } from "../lib/format.js";
import { useEventListener } from "../lib/sse.js";

interface ProjectSummary {
  project: Project;
  subscriptions: SubscriptionWithState[];
  lastSynced: string | null;
}

/** Derive the worst state across all subscriptions. */
function worstState(subs: SubscriptionWithState[]): SubscriptionWithState["state"] | null {
  if (subs.length === 0) return null;
  const priority: Record<SubscriptionWithState["state"], number> = {
    conflict: 0,
    behind: 1,
    "local-ahead": 2,
    pending: 3,
    synced: 4
  };
  return subs.reduce<SubscriptionWithState>(
    (best, s) => (priority[s.state] < priority[best.state] ? s : best),
    subs[0]
  ).state;
}

const STATE_CONFIG: Record<
  SubscriptionWithState["state"],
  { tone: "error" | "warn" | "accent" | "muted"; label: string }
> = {
  conflict:      { tone: "error",  label: "Conflict"     },
  behind:        { tone: "warn",   label: "Behind"       },
  "local-ahead": { tone: "warn",   label: "Local Ahead"  },
  pending:       { tone: "muted",  label: "Pending"      },
  synced:        { tone: "accent", label: "Synced"       }
};

export function DashboardPage(): React.JSX.Element {
  const [summaries, setSummaries] = useState<ProjectSummary[] | null>(null);
  const [projectCount, setProjectCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const { projects } = await api.listProjects({ limit: 500 });
      setProjectCount(projects.length);
      if (projects.length === 0) {
        setSummaries([]);
        return;
      }

      const results = await Promise.all(
        projects.map(async (project) => {
          try {
            const status = await api.projectStatus(project.id);
            return {
              project,
              subscriptions: status.subscriptions,
              lastSynced: status.last_synced
            } satisfies ProjectSummary;
          } catch {
            return {
              project,
              subscriptions: [],
              lastSynced: null
            } satisfies ProjectSummary;
          }
        })
      );

      // Sort by worst state first, then alphabetically by project name
      const priority: Record<SubscriptionWithState["state"], number> = {
        conflict: 0,
        behind: 1,
        "local-ahead": 2,
        pending: 3,
        synced: 4
      };
      const nullPriority = 5;
      results.sort((a, b) => {
        const wa = worstState(a.subscriptions);
        const wb = worstState(b.subscriptions);
        const pa = wa !== null ? priority[wa] : nullPriority;
        const pb = wb !== null ? priority[wb] : nullPriority;
        if (pa !== pb) return pa - pb;
        return a.project.name.localeCompare(b.project.name);
      });

      setSummaries(results);
    } catch (err) {
      setError(
        err instanceof AstackError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      );
      setSummaries([]);
      setProjectCount(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEventListener("skill.updated",    () => void load());
  useEventListener("conflict.detected",() => void load());
  useEventListener("sync.completed",   () => void load());

  useEffect(() => {
    const handler = (): void => void load();
    window.addEventListener("astack:refresh", handler);
    return () => window.removeEventListener("astack:refresh", handler);
  }, [load]);

  const attentionCount = useMemo(
    () =>
      (summaries ?? []).filter((s) => {
        const w = worstState(s.subscriptions);
        return w !== null && w !== "synced";
      }).length,
    [summaries]
  );

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        {summaries !== null && attentionCount > 0 ? (
          <Badge tone="warn">{attentionCount} need attention</Badge>
        ) : null}
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      {summaries === null ? (
        <div className="space-y-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : projectCount === 0 ? (
        <EmptyState
          title="No projects yet"
          hint="Register your first project to start syncing skills."
        >
          <Link to="/projects?action=new">
            <Button variant="primary">Register project</Button>
          </Link>
        </EmptyState>
      ) : summaries.every((s) => s.subscriptions.length === 0) ? (
        <EmptyState
          title="No skills subscribed yet"
          hint="Open a project and subscribe to skills from a repo to see sync status here."
        >
          <Link to="/projects">
            <Button variant="primary">Go to projects</Button>
          </Link>
        </EmptyState>
      ) : (
        <Card className="p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs border-b border-border">
                <th className="font-medium px-4 py-3 text-text-secondary">Project</th>
                <th className="font-medium px-4 py-3 text-text-secondary text-right">Skills</th>
                <th className="font-medium px-4 py-3 text-text-secondary text-right">Conflicts</th>
                <th className="font-medium px-4 py-3 text-text-secondary text-right">Behind</th>
                <th className="font-medium px-4 py-3 text-text-secondary text-right">Pending</th>
                <th className="font-medium px-4 py-3 text-text-secondary text-right">Synced</th>
                <th className="font-medium px-4 py-3 text-text-secondary">Status</th>
                <th className="font-medium px-4 py-3 text-text-secondary">Last synced</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((s) => (
                <ProjectRow key={s.project.id} summary={s} />
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function ProjectRow({ summary }: { summary: ProjectSummary }): React.JSX.Element {
  const navigate = useNavigate();
  const { project, subscriptions, lastSynced } = summary;

  const counts = useMemo(() => {
    const c = { conflict: 0, behind: 0, "local-ahead": 0, pending: 0, synced: 0 };
    for (const s of subscriptions) c[s.state]++;
    return c;
  }, [subscriptions]);

  const worst = worstState(subscriptions);
  const statusConfig = worst !== null ? STATE_CONFIG[worst] : null;

  const needsAttention =
    worst !== null && worst !== "synced" && subscriptions.length > 0;

  return (
    <tr
      className="border-t border-border hover:bg-elevated transition-colors cursor-pointer"
      onClick={() => navigate(`/projects/${project.id}`)}
    >
      {/* Project name */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {needsAttention ? (
            <span className="w-1.5 h-1.5 rounded-full bg-warn shrink-0" aria-hidden />
          ) : null}
          <span className="font-medium text-fg-primary">{project.name}</span>
          <span className="text-xs text-text-muted font-mono truncate max-w-[160px]">
            {project.path}
          </span>
        </div>
      </td>

      {/* Total skills */}
      <td className="px-4 py-3 text-right tabular text-text-secondary">
        {subscriptions.length}
      </td>

      {/* Conflict */}
      <td className="px-4 py-3 text-right tabular">
        {counts.conflict > 0 ? (
          <span className="text-error font-medium">{counts.conflict}</span>
        ) : (
          <span className="text-text-muted">—</span>
        )}
      </td>

      {/* Behind */}
      <td className="px-4 py-3 text-right tabular">
        {counts.behind > 0 ? (
          <span className="text-warn font-medium">{counts.behind}</span>
        ) : (
          <span className="text-text-muted">—</span>
        )}
      </td>

      {/* Pending */}
      <td className="px-4 py-3 text-right tabular">
        {counts.pending > 0 ? (
          <span className="text-text-secondary">{counts.pending}</span>
        ) : (
          <span className="text-text-muted">—</span>
        )}
      </td>

      {/* Synced */}
      <td className="px-4 py-3 text-right tabular">
        {counts.synced > 0 ? (
          <span className="text-accent">{counts.synced}</span>
        ) : (
          <span className="text-text-muted">—</span>
        )}
      </td>

      {/* Overall status */}
      <td className="px-4 py-3">
        {statusConfig !== null ? (
          <span className="inline-flex items-center gap-1.5">
            <StatusDot tone={statusConfig.tone} />
            <span className="text-xs text-text-secondary">{statusConfig.label}</span>
          </span>
        ) : (
          <span className="text-xs text-text-muted">No skills</span>
        )}
      </td>

      {/* Last synced */}
      <td className="px-4 py-3 text-xs text-text-muted">
        {relativeTime(lastSynced)}
      </td>
    </tr>
  );
}

function ErrorBanner({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="border border-error/40 bg-error/10 text-error rounded p-3 text-sm">
      <span className="font-medium">Daemon unreachable. </span>
      <span className="text-text-secondary">{message}</span>
      <div className="text-xs text-text-muted mt-1">
        Start it with <span className="font-mono">astack server start</span>.
      </div>
    </div>
  );
}
