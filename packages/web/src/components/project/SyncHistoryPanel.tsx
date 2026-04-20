import type * as React from "react";

import type { ListSyncLogsResponse, SyncLog } from "@astack/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Badge, Button, Card, Skeleton, StatusDot } from "../ui/index.js";
import { api, AstackError } from "../../lib/api.js";
import { relativeTime, shortHash } from "../../lib/format.js";

/**
 * SyncHistoryPanel — the Sync History tab.
 *
 * Renders the GET /api/projects/:id/sync-logs endpoint (added in v0.3
 * PR2). A timeline view, newest first, with filters (all / pull / push /
 * status) and [Load more] pagination.
 *
 * Click a row to expand from_version → to_version hash details. In a
 * later pass this could grow into a full diff preview, but for v0.3 the
 * expanded row gives users answers to "what did that sync actually do?"
 * without requiring another click.
 */

export interface SyncHistoryPanelProps {
  projectId: number;
}

type DirectionFilter = "all" | "pull" | "push";
type StatusFilter = "all" | "success" | "conflict" | "error";

const PAGE_SIZE = 25;

export function SyncHistoryPanel({
  projectId
}: SyncHistoryPanelProps): React.JSX.Element {
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [direction, setDirection] = useState<DirectionFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");

  const loadPage = useCallback(
    async (offset: number, append: boolean): Promise<void> => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        setError(null);
        const res: ListSyncLogsResponse = await api.listSyncLogs(projectId, {
          limit: PAGE_SIZE,
          offset,
          direction: direction === "all" ? undefined : direction,
          status: status === "all" ? undefined : status
        });
        setTotal(res.total);
        setHasMore(res.has_more);
        setLogs((prev) => (append ? [...prev, ...res.logs] : res.logs));
      } catch (err) {
        setError(
          err instanceof AstackError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err)
        );
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [projectId, direction, status]
  );

  // Reload when filters change.
  useEffect(() => {
    void loadPage(0, false);
  }, [loadPage]);

  const summary = useMemo(() => {
    const parts: string[] = [];
    parts.push(
      `${total} entr${total === 1 ? "y" : "ies"}`
    );
    if (direction !== "all") parts.push(direction);
    if (status !== "all") parts.push(status);
    return parts.join(" · ");
  }, [total, direction, status]);

  return (
    <section className="space-y-3 pt-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-fg-secondary">
          Sync History
          <span className="ml-2 text-xs text-fg-tertiary tabular">
            {summary}
          </span>
        </h2>
        <div className="flex items-center gap-3">
          <FilterDropdown
            label="Direction"
            value={direction}
            options={[
              { id: "all", label: "All" },
              { id: "pull", label: "Pull" },
              { id: "push", label: "Push" }
            ]}
            onChange={(v) => setDirection(v as DirectionFilter)}
          />
          <FilterDropdown
            label="Status"
            value={status}
            options={[
              { id: "all", label: "All" },
              { id: "success", label: "Success" },
              { id: "conflict", label: "Conflict" },
              { id: "error", label: "Error" }
            ]}
            onChange={(v) => setStatus(v as StatusFilter)}
          />
        </div>
      </div>

      {error ? (
        <div className="text-sm text-error px-3 py-2 border border-error/40 rounded-md bg-error/5">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : logs.length === 0 ? (
        <Card className="px-4 py-10 text-center">
          <div className="text-sm text-fg-secondary">
            No sync history yet.
          </div>
          <div className="text-xs text-fg-tertiary mt-1">
            Sync activity will appear here after your first pull or push.
          </div>
        </Card>
      ) : (
        <>
          <Card className="p-0 overflow-hidden">
            <ul className="divide-y divide-line-subtle">
              {logs.map((log) => (
                <HistoryRow
                  key={log.id}
                  log={log}
                  projectId={projectId}
                />
              ))}
            </ul>
          </Card>
          {hasMore ? (
            <div className="flex justify-center pt-2">
              <Button
                size="sm"
                onClick={() => void loadPage(logs.length, true)}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : `Load more (${total - logs.length} left)`}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

// ---------- HistoryRow ----------

function HistoryRow({
  log,
  projectId
}: {
  log: SyncLog;
  projectId: number;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const tone =
    log.status === "success"
      ? "accent"
      : log.status === "conflict"
        ? "warn"
        : "error";

  return (
    <li>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-1 transition-colors duration-fast"
      >
        <StatusDot tone={tone} />
        <span className="text-xs text-fg-secondary w-14">
          {log.direction === "pull" ? "Pull" : "Push"}
        </span>
        <span className="text-xs text-fg-tertiary flex-1 truncate">
          skill #{log.skill_id}
        </span>
        <span className="font-mono text-xs text-fg-tertiary tabular">
          {shortHash(log.from_version) || "—"}
        </span>
        <span className="text-fg-quaternary">→</span>
        <span className="font-mono text-xs text-fg-primary tabular">
          {shortHash(log.to_version) || "—"}
        </span>
        <span className="text-xs text-fg-tertiary ml-2 w-20 text-right">
          {relativeTime(log.synced_at)}
        </span>
      </button>
      {expanded ? (
        <div className="px-4 py-3 text-xs text-fg-secondary bg-surface-1 border-t border-line-subtle">
          <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-y-1 gap-x-4">
            <dt className="text-fg-tertiary">At</dt>
            <dd className="font-mono text-fg-secondary">
              {new Date(log.synced_at).toISOString()}
            </dd>
            <dt className="text-fg-tertiary">Status</dt>
            <dd>
              <Badge
                tone={
                  log.status === "success"
                    ? "accent"
                    : log.status === "conflict"
                      ? "warn"
                      : "error"
                }
              >
                {log.status}
              </Badge>
            </dd>
            <dt className="text-fg-tertiary">From</dt>
            <dd className="font-mono">{log.from_version ?? "—"}</dd>
            <dt className="text-fg-tertiary">To</dt>
            <dd className="font-mono">{log.to_version ?? "—"}</dd>
            {log.conflict_detail ? (
              <>
                <dt className="text-fg-tertiary">Detail</dt>
                <dd>{log.conflict_detail}</dd>
              </>
            ) : null}
          </dl>
          {log.status === "conflict" ? (
            <div className="mt-2">
              <Link
                to={`/resolve/${projectId}/${log.skill_id}`}
                className="text-accent hover:underline"
              >
                Resolve this conflict →
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

// ---------- FilterDropdown ----------

function FilterDropdown({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: Array<{ id: string; label: string }>;
  onChange: (v: string) => void;
}): React.JSX.Element {
  return (
    <label className="flex items-center gap-2 text-xs text-fg-tertiary">
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 px-2 bg-surface-1 border border-line-subtle rounded text-xs text-fg-primary focus:outline-none focus:border-accent/60"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
