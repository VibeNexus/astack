import type * as React from "react";
/**
 * Sync Status — the default workstation page.
 *
 * Per design review decision 2 (interaction states): show attention items
 * first; fall back to a "everything synced" empty state. Clicking a row
 * jumps to the relevant resolution page or the Skill Matrix.
 */

import type {
  Project,
  SubscriptionWithState
} from "@astack/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Badge, Button, Card, EmptyState, Skeleton, StatusDot } from "../components/ui/index.js";
import { api, AstackError } from "../lib/api.js";
import {
  relativeTime,
  shortHash,
  subscriptionPriority,
  subscriptionStatusInfo
} from "../lib/format.js";
import { useEventListener } from "../lib/sse.js";
import { useToast } from "../lib/toast.js";

type Row = {
  project: Project;
  sub: SubscriptionWithState;
};

export function SyncStatusPage(): React.JSX.Element {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [projectCount, setProjectCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedByProject, setLastSyncedByProject] = useState<
    Record<number, string | null>
  >({});
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setError(null);
      const { projects } = await api.listProjects({ limit: 500 });
      setProjectCount(projects.length);
      if (projects.length === 0) {
        setRows([]);
        return;
      }
      const all: Row[] = [];
      const lastSynced: Record<number, string | null> = {};
      await Promise.all(
        projects.map(async (project) => {
          try {
            const status = await api.projectStatus(project.id);
            lastSynced[project.id] = status.last_synced;
            for (const sub of status.subscriptions) {
              all.push({ project, sub });
            }
          } catch {
            // leave this project out if status fetch fails
          }
        })
      );
      all.sort((a, b) => {
        const p = subscriptionPriority(a.sub.state) - subscriptionPriority(b.sub.state);
        if (p !== 0) return p;
        return a.sub.skill.name.localeCompare(b.sub.skill.name);
      });
      setRows(all);
      setLastSyncedByProject(lastSynced);
    } catch (err) {
      setError(
        err instanceof AstackError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      );
      setRows([]);
      setProjectCount(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEventListener("skill.updated", () => void load());
  useEventListener("conflict.detected", () => void load());
  useEventListener("sync.completed", () => void load());

  useEffect(() => {
    const handler = (): void => void load();
    window.addEventListener("astack:refresh", handler);
    return () => window.removeEventListener("astack:refresh", handler);
  }, [load]);

  const attention = useMemo(
    () => (rows ?? []).filter((r) => r.sub.state !== "synced"),
    [rows]
  );
  const synced = useMemo(
    () => (rows ?? []).filter((r) => r.sub.state === "synced"),
    [rows]
  );

  async function handleSync(projectId: number): Promise<void> {
    try {
      const res = await api.sync(projectId);
      if (res.conflicts > 0) {
        toast.warn(
          `Synced with ${res.conflicts} conflict(s)`,
          "Open the Sync Status page to resolve"
        );
      } else if (res.synced > 0 || res.up_to_date > 0) {
        toast.ok(`Synced ${res.synced} skill(s), ${res.up_to_date} up-to-date`);
      } else {
        toast.ok("Nothing to sync");
      }
      await load();
    } catch (err) {
      toast.error(
        "Sync failed",
        err instanceof AstackError ? err.message : String(err)
      );
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Sync Status" />

      {error ? <ErrorBanner message={error} /> : null}

      {rows === null ? (
        <div className="space-y-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
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
      ) : rows.length === 0 ? (
        <EmptyState
          title="No skills subscribed yet"
          hint="Open a project and subscribe to skills from a repo to see sync status here."
        >
          <Link to="/projects">
            <Button variant="primary">Go to projects</Button>
          </Link>
        </EmptyState>
      ) : (
        <>
          <section>
            <SectionHeading
              title="Needs attention"
              count={attention.length}
              badgeTone="warn"
            />
            {attention.length === 0 ? (
              <Card className="text-sm text-text-secondary">
                Everything is synced. 🎉
              </Card>
            ) : (
              <div className="space-y-2">
                {attention.map((r) => (
                  <AttentionRow
                    key={`${r.project.id}-${r.sub.skill.id}`}
                    row={r}
                    onSync={handleSync}
                  />
                ))}
              </div>
            )}
          </section>

          <section>
            <SectionHeading title="Synced" count={synced.length} />
            <Card className="p-0 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-text-muted text-xs">
                    <th className="font-normal px-3 py-2">Project</th>
                    <th className="font-normal px-3 py-2">Skill</th>
                    <th className="font-normal px-3 py-2">Repo</th>
                    <th className="font-normal px-3 py-2">Version</th>
                    <th className="font-normal px-3 py-2">Last synced</th>
                  </tr>
                </thead>
                <tbody>
                  {synced.map((r) => (
                    <tr
                      key={`${r.project.id}-${r.sub.skill.id}`}
                      className="border-t border-border hover:bg-elevated transition-colors"
                    >
                      <td className="px-3 py-2">
                        <Link
                          to={`/projects/${r.project.id}`}
                          className="hover:text-accent"
                        >
                          {r.project.name}
                        </Link>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {r.sub.skill.name}
                      </td>
                      <td className="px-3 py-2 text-text-secondary">
                        {r.sub.repo.name}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-text-muted">
                        {shortHash(r.sub.skill.version)}
                      </td>
                      <td className="px-3 py-2 text-text-muted">
                        {relativeTime(lastSyncedByProject[r.project.id])}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}

function PageHeader({ title }: { title: string }): React.JSX.Element {
  return (
    <div className="flex items-end justify-between">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
    </div>
  );
}

function SectionHeading({
  title,
  count,
  badgeTone
}: {
  title: string;
  count: number;
  badgeTone?: "warn" | "neutral";
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 mb-2">
      <h2 className="text-sm font-medium text-text-secondary">{title}</h2>
      <Badge tone={badgeTone ?? "neutral"}>{count}</Badge>
    </div>
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

function AttentionRow({
  row,
  onSync
}: {
  row: Row;
  onSync: (projectId: number) => void;
}): React.JSX.Element {
  const { sub, project } = row;
  const info = subscriptionStatusInfo(sub.state);
  return (
    <Card className="flex items-center justify-between py-2 px-3 hover:bg-elevated transition-colors">
      <div className="flex items-center gap-3 min-w-0">
        <span
          className="inline-flex items-center gap-1 text-sm"
          style={{ width: 120 }}
        >
          <StatusDot tone={info.tone} />
          <span className="text-text-secondary">{info.label}</span>
        </span>
        <Link
          to={`/projects/${project.id}`}
          className="text-sm truncate hover:text-accent"
        >
          {project.name}
        </Link>
        <span className="text-text-muted">/</span>
        <span className="font-mono text-xs truncate">
          {sub.skill.name}
        </span>
        <span className="text-text-muted text-xs hidden md:inline">
          {sub.repo.name}
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs text-text-muted">
          {sub.state_detail ?? ""}
        </span>
        {sub.state === "conflict" ? (
          <Link to={`/resolve/${project.id}/${sub.skill.id}`}>
            <Button variant="outline" size="sm">
              Resolve
            </Button>
          </Link>
        ) : (
          <Button
            size="sm"
            variant="primary"
            onClick={() => onSync(project.id)}
          >
            Sync
          </Button>
        )}
      </div>
    </Card>
  );
}
