import type * as React from "react";

import type { GetProjectStatusResponse, LinkedDir } from "@astack/shared";
import { Link } from "react-router-dom";

import { Button } from "../ui/index.js";
import { relativeTime } from "../../lib/format.js";

/**
 * Project detail page header — navigation crumb, title/path, summary line,
 * and the Sync/Push action buttons.
 *
 * Summary line is the visual anchor the v0.3 design review called for.
 * It lives between the identity block and the actions so eye flow goes:
 *   "who am I looking at" → "what's its health" → "what can I do".
 */

export interface ProjectHeaderProps {
  status: GetProjectStatusResponse;
  /** Number of linked_dirs across all statuses (enriched LinkedDir array). */
  linkedDirs: LinkedDir[];
  onSync: () => void | Promise<void>;
  onPush: () => void | Promise<void>;
  /** Disables action buttons while a mutation is in flight. */
  busy?: boolean;
}

export function ProjectHeader({
  status,
  linkedDirs,
  onSync,
  onPush,
  busy
}: ProjectHeaderProps): React.JSX.Element {
  const { project, subscriptions, last_synced } = status;
  const attentionCount = subscriptions.filter(
    (s) => s.state !== "synced"
  ).length;
  const brokenTools = linkedDirs.filter((t) => t.status === "broken").length;

  return (
    <header>
      <Link
        to="/projects"
        className="text-xs text-fg-tertiary hover:text-fg-secondary inline-flex items-center gap-1"
      >
        ← Projects
      </Link>
      <div className="mt-1 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg-primary truncate">
            {project.name}
          </h1>
          <div className="text-xs text-fg-tertiary font-mono mt-1 truncate">
            {project.path}
          </div>
          <SummaryLine
            subscriptions={subscriptions.length}
            attention={attentionCount}
            tools={linkedDirs.length}
            brokenTools={brokenTools}
            lastSynced={last_synced}
          />
        </div>
        <div className="flex gap-2 shrink-0">
          <Button onClick={onSync} disabled={busy}>
            Sync
          </Button>
          <Button variant="primary" onClick={onPush} disabled={busy}>
            Push
          </Button>
        </div>
      </div>
    </header>
  );
}

/**
 * One-line project health summary. Format:
 *   ● 12 skills · 2 need attention · 3 tools · synced 2m ago
 *
 * Only shows "X need attention" when positive, and only shows "N broken
 * tools" when > 0 — keeps the good-path one-liner clean.
 */
function SummaryLine({
  subscriptions,
  attention,
  tools,
  brokenTools,
  lastSynced
}: {
  subscriptions: number;
  attention: number;
  tools: number;
  brokenTools: number;
  lastSynced: string | null;
}): React.JSX.Element {
  const healthy = attention === 0 && brokenTools === 0;
  const dotClass = healthy ? "bg-accent" : "bg-warn";
  const parts: string[] = [];
  parts.push(`${subscriptions} ${subscriptions === 1 ? "skill" : "skills"}`);
  if (attention > 0) parts.push(`${attention} need attention`);
  parts.push(`${tools} ${tools === 1 ? "tool" : "tools"}`);
  if (brokenTools > 0) parts.push(`${brokenTools} broken`);
  parts.push(`synced ${relativeTime(lastSynced)}`);
  return (
    <div className="mt-2 flex items-center gap-2 text-xs text-fg-secondary">
      <span
        aria-hidden
        className={`inline-block w-1.5 h-1.5 rounded-full ${dotClass}`}
      />
      <span>{parts.join(" · ")}</span>
    </div>
  );
}
