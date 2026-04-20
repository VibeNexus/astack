import type * as React from "react";
/**
 * Project detail — v0.3 redesign.
 *
 * Layout:
 *   ProjectHeader (crumb, title, path, SummaryBar, Sync/Push buttons)
 *   Tabs — Subscriptions / Linked Tools / Sync History / Settings
 *   TabPanel for each
 *
 * State management:
 *   - `status` — full GetProjectStatusResponse (SubscriptionWithState[] + ToolLink[])
 *   - `useSearchParams` drives the active tab so deep links + browser
 *     back/forward both work. Invalid `?tab=<unknown>` falls back to
 *     'subscriptions' silently (see validateTab).
 *
 * Actions go through useProjectActions (lib/useProjectActions.ts) which
 * consolidates the try/catch/toast/reload boilerplate.
 *
 * PRs after this one:
 *   PR7 — Browse Skills Drawer + SyncResultCard (the real + Add flow)
 *   PR8 — Linked Tools / Sync History / Settings tab content
 *   PR9 — Mobile responsive + CommandPalette extensions + a11y polish
 */

import type { GetProjectStatusResponse, SubscribeResponse, SyncResponse } from "@astack/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import {
  BrowseSkillsDrawer,
  makeSubscribedRefSet
} from "../components/project/BrowseSkillsDrawer.js";
import { HarnessPanel } from "../components/project/HarnessPanel.js";
import { LinkedToolsPanel } from "../components/project/LinkedToolsPanel.js";
import { ProjectHeader } from "../components/project/ProjectHeader.js";
import { ProjectSettingsPanel } from "../components/project/ProjectSettingsPanel.js";
import { SubscriptionsPanel } from "../components/project/SubscriptionsPanel.js";
import { SyncHistoryPanel } from "../components/project/SyncHistoryPanel.js";
import { SyncResultCard } from "../components/project/SyncResultCard.js";
import { Skeleton, TabPanel, Tabs, type TabItem } from "../components/ui/index.js";
import { api, AstackError } from "../lib/api.js";
import { useToast } from "../lib/toast.js";
import { useEventListener } from "../lib/sse.js";
import { useProjectActions } from "../lib/useProjectActions.js";

// Stable set of tab ids — used for validating ?tab= and keyed lookup.
const TAB_IDS = ["subscriptions", "tools", "history", "harness", "settings"] as const;
type TabId = (typeof TAB_IDS)[number];

/** `?tab=<hack>` → fallback to 'subscriptions'. */
function validateTab(raw: string | null): TabId {
  return (TAB_IDS as readonly string[]).includes(raw ?? "")
    ? (raw as TabId)
    : "subscriptions";
}

export function ProjectDetailPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const projectId = Number(id);
  const [status, setStatus] = useState<GetProjectStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const activeTab = validateTab(params.get("tab"));
  const [browseOpen, setBrowseOpen] = useState(false);
  // Persisted sync-card state — stays visible until user dismisses, so
  // conflicts don't flash away behind a toast. Supplants the pre-v0.3
  // "Synced 3, 0 conflicts" one-liner for the batch subscribe + sync
  // flow; a plain Sync button still uses a toast (cheaper when there
  // are zero outcomes worth listing).
  const [syncCard, setSyncCard] = useState<{
    result: SyncResponse;
    failures?: SubscribeResponse["failures"];
    readonlySkipped?: number;
  } | null>(null);
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

  const actions = useProjectActions(projectId, load);

  async function handleSync(): Promise<void> {
    const r = await actions.runAction(() => api.sync(projectId), {
      errMsg: "Sync failed"
    });
    if (r) {
      // PR7 replaces this toast with a SyncResultCard. Keep the toast
      // behavior byte-identical to the pre-v0.3 implementation for now.
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

  async function handleUnregister(): Promise<void> {
    const r = await actions.runAction(
      () => api.deleteProject(projectId),
      { errMsg: "Unregister failed", skipReload: true }
    );
    if (r) {
      toast.ok("Project unregistered");
      // Navigate back to project list; a manual window.location is
      // cleaner than wiring useNavigate here since this is a one-shot
      // terminal action.
      window.location.href = "/projects";
    }
  }

  /**
   * Post-batch handler for BrowseSkillsDrawer. Stash the subscribe+sync
   * result so the SyncResultCard renders it, and reload project status
   * so the new rows appear. We do NOT reconstruct a full SyncResponse
   * when there were zero successful subscribes (no sync happened) —
   * show only the failure half in that case.
   */
  async function handleSubscribed(result: SubscribeResponse): Promise<void> {
    // Recompose a SyncResponse-shaped object from the subscribe logs so
    // the existing SyncResultCard can render it. api.subscribe returns
    // sync_logs but not outcomes — we synthesize minimal outcomes from
    // logs so the "Updated N" section has something to show.
    const logs = result.sync_logs;
    const synced = logs.filter((l) => l.status === "success").length;
    const conflicts = logs.filter((l) => l.status === "conflict").length;
    const errors = logs.filter((l) => l.status === "error").length;
    const syntheticResult: SyncResponse = {
      outcomes: [], // subscribe endpoint doesn't expose full outcomes yet
      synced,
      up_to_date: 0,
      conflicts,
      errors
    };
    setSyncCard({
      result: syntheticResult,
      failures: result.failures.length > 0 ? result.failures : undefined
    });
    await load();
  }

  // Memoized set of refs the user has already subscribed to — used by
  // BrowseSkillsDrawer to disable those rows. Declared BEFORE any early
  // return so Rules of Hooks stay consistent across renders (skeleton
  // branch must still call the same hooks in the same order).
  const alreadySubscribed = useMemo(
    () => makeSubscribedRefSet(status?.subscriptions ?? []),
    [status?.subscriptions]
  );

  // ---- render ----

  if (error) {
    return (
      <div className="space-y-3">
        <div className="text-sm text-error">{error}</div>
        <Link to="/projects" className="text-sm text-fg-secondary underline">
          ← back to Projects
        </Link>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-60" />
        <Skeleton className="h-5 w-96" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  // Tab definitions include live badges so users see "3 attention items"
  // on the Subscriptions tab without clicking through.
  const attentionCount = status.subscriptions.filter(
    (s) => s.state !== "synced"
  ).length;
  const brokenTools = status.tool_links.filter(
    (t) => t.status === "broken"
  ).length;
  const tabs: readonly TabItem[] = [
    {
      id: "subscriptions",
      label: "Subscriptions",
      badge: status.subscriptions.length
    },
    {
      id: "tools",
      label: "Linked Tools",
      badge: status.tool_links.length
    },
    { id: "history", label: "Sync History" },
    {
      id: "harness",
      label: "Harness",
      // Badge left blank intentionally — HarnessPanel owns its own status
      // display. A naive count here would either always-1 (noisy) or
      // require another fetch (wasteful).
    },
    { id: "settings", label: "Settings" }
  ];

  const setTab = (id: string): void => {
    const next = new URLSearchParams(params);
    // Keep URL clean: omit the param when default (subscriptions).
    if (id === "subscriptions") next.delete("tab");
    else next.set("tab", id);
    setParams(next, { replace: false });
  };

  return (
    <div className="space-y-6">
      <ProjectHeader
        status={status}
        toolLinks={status.tool_links}
        onSync={handleSync}
        onPush={handlePush}
      />

      {syncCard && (
        <SyncResultCard
          projectId={projectId}
          result={syncCard.result}
          subscribeFailures={syncCard.failures}
          readonlySkipped={syncCard.readonlySkipped}
          onDismiss={() => setSyncCard(null)}
        />
      )}
      {/* Attention pills are informational; the top-of-page visual comes from
         the SummaryLine + the tab badges themselves. Skipping a stand-alone
         banner keeps the layout calmer. */}
      {attentionCount > 0 || brokenTools > 0 ? (
        <div className="text-xs text-fg-tertiary">
          {attentionCount > 0 && (
            <span>
              {attentionCount} subscription{attentionCount === 1 ? "" : "s"}{" "}
              need attention
            </span>
          )}
          {attentionCount > 0 && brokenTools > 0 && (
            <span className="mx-1">·</span>
          )}
          {brokenTools > 0 && (
            <span>
              {brokenTools} broken tool link{brokenTools === 1 ? "" : "s"}
            </span>
          )}
        </div>
      ) : null}

      <Tabs
        tabs={tabs}
        activeId={activeTab}
        onChange={setTab}
        aria-label="Project sections"
        idPrefix="project-detail"
      />

      <TabPanel tabId="subscriptions" activeId={activeTab} idPrefix="project-detail">
        <SubscriptionsPanel
          status={status}
          projectId={projectId}
          onUnsubscribe={handleUnsubscribe}
          onBrowse={() => setBrowseOpen(true)}
        />
      </TabPanel>

      <TabPanel tabId="tools" activeId={activeTab} idPrefix="project-detail">
        <LinkedToolsPanel
          links={status.tool_links}
          onAdd={async (tool) => {
            await actions.addLink(tool);
          }}
          onRemove={(tool) => {
            if (!confirm(`Remove ${tool} link?`)) return;
            void actions.removeLink(tool);
          }}
        />
      </TabPanel>

      <TabPanel tabId="history" activeId={activeTab} idPrefix="project-detail">
        <SyncHistoryPanel projectId={projectId} />
      </TabPanel>

      <TabPanel tabId="harness" activeId={activeTab} idPrefix="project-detail">
        <HarnessPanel projectId={projectId} />
      </TabPanel>

      <TabPanel tabId="settings" activeId={activeTab} idPrefix="project-detail">
        <ProjectSettingsPanel
          project={status.project}
          onUnregister={handleUnregister}
        />
      </TabPanel>

      <BrowseSkillsDrawer
        projectId={projectId}
        open={browseOpen}
        onClose={() => setBrowseOpen(false)}
        alreadySubscribed={alreadySubscribed}
        onSubscribed={handleSubscribed}
      />
    </div>
  );
}
