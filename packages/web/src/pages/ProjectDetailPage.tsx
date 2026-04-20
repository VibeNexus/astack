import type * as React from "react";
/**
 * Project detail — subscriptions, tool links, and actions for one project.
 */

import type { GetProjectStatusResponse } from "@astack/shared";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  Badge,
  Button,
  Card,
  Skeleton,
  StatusDot
} from "../components/ui/index.js";
import { api, AstackError } from "../lib/api.js";
import {
  relativeTime,
  shortHash,
  subscriptionStatusInfo,
  toolLinkStatusInfo
} from "../lib/format.js";
import { useEventListener } from "../lib/sse.js";
import { useToast } from "../lib/toast.js";
import { useProjectActions } from "../lib/useProjectActions.js";

export function ProjectDetailPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const projectId = Number(id);
  const [status, setStatus] = useState<GetProjectStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    if (!Number.isFinite(projectId) || projectId <= 0) {
      setError("Invalid project id");
      return;
    }
    try {
      setError(null);
      const res = await api.projectStatus(projectId);
      setStatus(res);
    } catch (err) {
      setError(
        err instanceof AstackError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      );
      setStatus(null);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEventListener("skill.updated", () => void load());
  useEventListener("tool_link.created", () => void load());
  useEventListener("tool_link.removed", () => void load());
  useEventListener("tool_link.broken", () => void load());
  useEventListener("conflict.detected", () => void load());

  // v0.3: generic mutation handlers go through useProjectActions (DRY).
  // Sync/Push keep custom result-to-toast logic here because they have
  // multi-branch messaging (pushed vs. conflicts vs. readonly_skipped),
  // not a single okMsg — so we use runAction as the escape hatch and
  // handle the non-error result locally.
  const actions = useProjectActions(projectId, load);

  async function handleSync(): Promise<void> {
    const r = await actions.runAction(() => api.sync(projectId), {
      errMsg: "Sync failed"
    });
    if (r) {
      toast.ok(`Synced ${r.synced}, ${r.conflicts} conflict(s)`);
    }
  }

  async function handlePush(): Promise<void> {
    const r = await actions.runAction(() => api.push(projectId), {
      errMsg: "Push failed"
    });
    if (!r) return;
    if (r.pushed > 0) toast.ok(`Pushed ${r.pushed} skill(s)`);
    else if (r.conflicts > 0) toast.warn(`${r.conflicts} conflict(s)`);
    else if (r.readonly_skipped > 0 && r.pushed === 0) {
      toast.warn(
        `${r.readonly_skipped} skipped`,
        "All edited skills live in pull-only (open-source) repos."
      );
    } else toast.ok("Nothing to push");
  }

  async function handleUnsubscribe(skillId: number): Promise<void> {
    if (!confirm("Unsubscribe this skill?")) return;
    await actions.unsubscribe(skillId);
  }

  async function handleAddLink(tool: string): Promise<void> {
    await actions.addLink(tool);
  }

  async function handleRemoveLink(tool: string): Promise<void> {
    if (!confirm(`Remove ${tool} link?`)) return;
    await actions.removeLink(tool);
  }

  if (error) {
    return (
      <div className="space-y-3">
        <div className="text-sm text-error">{error}</div>
        <Link to="/projects" className="text-sm text-text-secondary underline">
          ← back to Projects
        </Link>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-60" />
        <Skeleton className="h-24" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <Link
            to="/projects"
            className="text-xs text-text-muted hover:text-text-secondary"
          >
            ← Projects
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight mt-1">
            {status.project.name}
          </h1>
          <div className="text-xs text-text-muted font-mono mt-1">
            {status.project.path}
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={handleSync}>Sync</Button>
          <Button variant="primary" onClick={handlePush}>
            Push
          </Button>
        </div>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-secondary">
          Subscriptions
          <Badge tone="neutral" className="ml-2">
            {status.subscriptions.length}
          </Badge>
        </h2>
        {status.subscriptions.length === 0 ? (
          <Card className="text-sm text-text-secondary">
            No subscriptions yet. Use the CLI:{" "}
            <span className="font-mono">astack subscribe &lt;skill&gt;</span>
          </Card>
        ) : (
          <Card className="p-0 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-muted text-xs">
                  <th className="font-normal px-3 py-2">State</th>
                  <th className="font-normal px-3 py-2">Skill</th>
                  <th className="font-normal px-3 py-2">Repo</th>
                  <th className="font-normal px-3 py-2">Version</th>
                  <th className="font-normal px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {status.subscriptions.map((s) => {
                  const info = subscriptionStatusInfo(s.state);
                  return (
                    <tr
                      key={s.skill.id}
                      className="border-t border-border hover:bg-elevated"
                    >
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-2">
                          <StatusDot tone={info.tone} />
                          <span className="text-text-secondary">
                            {info.label}
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {s.skill.name}
                        {s.skill.type === "skill" ? (
                          <Badge tone="neutral" className="ml-1">
                            dir
                          </Badge>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-text-secondary">
                        <span className="inline-flex items-center gap-2">
                          {s.repo.name}
                          {s.repo.kind === "open-source" ? (
                            <Badge
                              tone="warn"
                              title="Open-source repo — pull only"
                            >
                              read-only
                            </Badge>
                          ) : null}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-text-muted">
                        {shortHash(s.skill.version)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {s.state === "conflict" ? (
                          <Link
                            to={`/resolve/${projectId}/${s.skill.id}`}
                          >
                            <Button size="sm">Resolve</Button>
                          </Link>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleUnsubscribe(s.skill.id)}
                            className="text-error hover:text-error"
                          >
                            Unsubscribe
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-secondary">
          Linked tools
          <Badge tone="neutral" className="ml-2">
            {status.tool_links.length}
          </Badge>
        </h2>
        <Card>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            {status.tool_links.map((l) => {
              const info = toolLinkStatusInfo(l.status);
              return (
                <div
                  key={l.id}
                  className="flex items-center gap-2 border border-border rounded px-2 py-1 text-xs"
                >
                  <StatusDot tone={info.tone} />
                  <span>{l.tool_name}</span>
                  <span className="text-text-muted font-mono">{l.dir_name}</span>
                  <button
                    className="text-text-muted hover:text-error ml-1"
                    onClick={() => handleRemoveLink(l.tool_name)}
                    aria-label={`remove ${l.tool_name} link`}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          <div className="text-xs text-text-muted mb-1">Add tool</div>
          <div className="flex gap-2">
            {["cursor", "codebuddy", "windsurf"].map((tool) => {
              const already = status.tool_links.some(
                (l) => l.tool_name === tool
              );
              return (
                <Button
                  key={tool}
                  size="sm"
                  disabled={already}
                  onClick={() => handleAddLink(tool)}
                >
                  + {tool}
                </Button>
              );
            })}
          </div>
        </Card>
      </section>

      <div className="text-xs text-text-muted">
        Last synced: {relativeTime(status.last_synced)}
      </div>
    </div>
  );
}
