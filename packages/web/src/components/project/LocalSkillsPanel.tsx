import type * as React from "react";

import type {
  ApplyLocalSkillsResult,
  BootstrapUnmatched,
  LocalSkill,
  LocalSkillStatus,
  SkillType,
  UnadoptLocalSkillsResult
} from "@astack/shared";
import { useMemo, useState } from "react";

import { Badge, Card } from "../ui/index.js";
import { AdoptDrawer } from "./AdoptDrawer.js";

/**
 * LocalSkillsPanel — v0.7 Local Skills tab body.
 *
 * The tab is a standalone view over `local_skills` table rows for a
 * project. Unlike Subscriptions (which have upstream, sync, and conflict
 * semantics), Local Skills are purely an index of on-disk `.claude/*`
 * assets the user has adopted — no push, no pull, no conflict.
 *
 * Sections:
 *   1. Header with count + [Rescan] + [+ Adopt from suggestions (N)]
 *   2. One-time auto-adopt banner (§1.15 / risk #1) when the project
 *      has any origin='auto' row and localStorage hasn't recorded a
 *      review yet
 *   3. Three grouped tables: Skills / Commands / Agents (like
 *      SubscriptionsPanel) — empty groups are hidden
 *   4. Empty state when zero rows + zero suggestions (never expected
 *      post-auto-adopt for legacy projects, but handles blank projects)
 *
 * State (ownership):
 *   - `adoptOpen` — AdoptDrawer visibility (local)
 *   - Everything else (loading, reloading, rows, suggestions) is owned
 *     by ProjectDetailPage; Panel is a pure(ish) renderer + callback
 *     surface.
 */

/** Keys for localStorage flags. Mirrors the convention used elsewhere. */
function autoAdoptReviewedKey(projectId: number): string {
  return `astack.local_skill_auto_adopt_reviewed.${projectId}`;
}

function readAutoAdoptReviewed(projectId: number): boolean {
  if (typeof window === "undefined") return true;
  try {
    const ls = window.localStorage;
    if (!ls || typeof ls.getItem !== "function") return false;
    return ls.getItem(autoAdoptReviewedKey(projectId)) === "true";
  } catch {
    return false;
  }
}

function writeAutoAdoptReviewed(projectId: number): void {
  if (typeof window === "undefined") return;
  try {
    const ls = window.localStorage;
    if (!ls || typeof ls.setItem !== "function") return;
    ls.setItem(autoAdoptReviewedKey(projectId), "true");
  } catch {
    // ignore — private mode or quota
  }
}

/**
 * Maps status → badge tone + copy + tooltip. Authoritative copy from
 * spec §1.15 (State 徽章 copy 矩阵). Centralized so the matrix lives
 * in one place and tests can import it directly.
 */
export const LOCAL_SKILL_STATUS_INFO: Record<
  LocalSkillStatus,
  { label: string; tone: "neutral" | "accent" | "warn" | "error"; tooltip: string | null }
> = {
  present: {
    label: "Present",
    tone: "neutral",
    tooltip: null
  },
  modified: {
    label: "Modified",
    tone: "accent",
    tooltip: "You've edited this local skill since it was adopted."
  },
  missing: {
    label: "Missing",
    tone: "neutral",
    tooltip:
      "Tracked in astack but not found on disk. Rescan or Unadopt to clean up."
  },
  name_collision: {
    label: "Collision",
    tone: "warn",
    tooltip: "Also subscribed via a registered repo."
  }
};

export interface LocalSkillsPanelProps {
  projectId: number;
  localSkills: LocalSkill[];
  suggestions: BootstrapUnmatched[];
  /** Server action: adopt selected entries. */
  onAdopt: (
    entries: Array<{ type: SkillType; name: string }>
  ) => Promise<ApplyLocalSkillsResult>;
  /** Server action: unadopt one row (parent owns confirmation UX). */
  onUnadopt: (
    entry: { type: SkillType; name: string },
    options: { delete_files: boolean }
  ) => Promise<UnadoptLocalSkillsResult>;
  /** Server action: rescan all rows in this project. */
  onRescan: () => void | Promise<void>;
}

export function LocalSkillsPanel({
  projectId,
  localSkills,
  suggestions,
  onAdopt,
  onUnadopt,
  onRescan
}: LocalSkillsPanelProps): React.JSX.Element {
  const [adoptOpen, setAdoptOpen] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [autoBannerDismissed, setAutoBannerDismissed] = useState<boolean>(
    () => readAutoAdoptReviewed(projectId)
  );

  const hasAutoAdopted = useMemo(
    () => localSkills.some((s) => s.origin === "auto"),
    [localSkills]
  );

  const autoBannerVisible = hasAutoAdopted && !autoBannerDismissed;

  function dismissAutoBanner(): void {
    writeAutoAdoptReviewed(projectId);
    setAutoBannerDismissed(true);
  }

  async function handleRescan(): Promise<void> {
    if (rescanning) return;
    setRescanning(true);
    try {
      await onRescan();
    } finally {
      setRescanning(false);
    }
  }

  const skills = localSkills.filter((s) => s.type === "skill");
  const commands = localSkills.filter((s) => s.type === "command");
  const agents = localSkills.filter((s) => s.type === "agent");
  const autoAdoptedCount = localSkills.filter((s) => s.origin === "auto").length;

  return (
    <section className="space-y-3 pt-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-fg-secondary">
          Local Skills
          <span className="ml-2 text-xs text-fg-tertiary tabular">
            {localSkills.length}
          </span>
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRescan}
            disabled={rescanning}
            className="h-8 px-3 text-sm inline-flex items-center gap-1.5 rounded-md border border-line-subtle text-fg-secondary hover:text-fg-primary hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent/60 transition-colors duration-fast disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {rescanning ? "Rescanning…" : "Rescan"}
          </button>
          {suggestions.length > 0 && (
            <button
              type="button"
              onClick={() => setAdoptOpen(true)}
              className="h-8 px-3 text-sm inline-flex items-center gap-1.5 rounded-md bg-accent text-accent-fg hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60 transition-colors duration-fast"
            >
              + Adopt from suggestions ({suggestions.length})
            </button>
          )}
        </div>
      </div>

      {autoBannerVisible && (
        <AutoAdoptBanner
          count={autoAdoptedCount}
          onDismiss={dismissAutoBanner}
        />
      )}

      {localSkills.length === 0 ? (
        suggestions.length > 0 ? (
          <LocalSkillsEmptyWithSuggestions
            count={suggestions.length}
            onAdopt={() => setAdoptOpen(true)}
          />
        ) : (
          <LocalSkillsEmpty />
        )
      ) : (
        <div className="space-y-4">
          {skills.length > 0 && (
            <LocalSkillGroup
              title="Skills"
              description="Directory-packaged skills with a SKILL.md manifest."
              tagText="dir"
              rows={skills}
              onUnadopt={onUnadopt}
            />
          )}
          {commands.length > 0 && (
            <LocalSkillGroup
              title="Commands"
              description="Single-file slash commands under .claude/commands/."
              tagText="cmd"
              rows={commands}
              onUnadopt={onUnadopt}
            />
          )}
          {agents.length > 0 && (
            <LocalSkillGroup
              title="Agents"
              description="Single-file autonomous subagents under .claude/agents/."
              tagText="agent"
              rows={agents}
              onUnadopt={onUnadopt}
            />
          )}
        </div>
      )}

      <AdoptDrawer
        open={adoptOpen}
        onClose={() => setAdoptOpen(false)}
        suggestions={suggestions}
        onApply={onAdopt}
      />
    </section>
  );
}

function AutoAdoptBanner({
  count,
  onDismiss
}: {
  count: number;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div
      role="note"
      aria-label="Auto-adopted local skills"
      data-testid="local-skills-auto-adopt-banner"
      className="flex items-start justify-between gap-3 rounded-md border border-accent/30 bg-accent/10 px-4 py-3"
    >
      <div className="text-sm text-fg-primary">
        <div className="font-medium">
          {count} local skill{count === 1 ? "" : "s"} auto-adopted from your
          existing <code className="font-mono">.claude/</code> directory.
        </div>
        <div className="text-xs text-fg-secondary mt-1 max-w-prose">
          Review and Unadopt any you don&apos;t want astack to track. Adopting
          never modifies files — it&apos;s an index, not a transfer.
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="text-xs text-fg-tertiary hover:text-fg-primary underline shrink-0"
      >
        Dismiss
      </button>
    </div>
  );
}

function LocalSkillsEmpty(): React.JSX.Element {
  return (
    <div className="flex flex-col items-start gap-3 py-10 px-6 border border-dashed border-line-subtle rounded-lg">
      <div>
        <div className="text-base font-semibold text-fg-primary">
          No local skills yet
        </div>
        <div className="text-sm text-fg-secondary mt-1 max-w-md">
          Anything you drop under{" "}
          <code className="font-mono text-fg-primary">.claude/skills/</code>,{" "}
          <code className="font-mono text-fg-primary">.claude/commands/</code>,
          or{" "}
          <code className="font-mono text-fg-primary">.claude/agents/</code>{" "}
          can be adopted here. Local skills stay on your machine — astack
          only tracks them.
        </div>
      </div>
    </div>
  );
}

function LocalSkillsEmptyWithSuggestions({
  count,
  onAdopt
}: {
  count: number;
  onAdopt: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-start gap-4 py-8 px-6 border border-dashed border-line-subtle rounded-lg">
      <div>
        <div className="text-base font-semibold text-fg-primary">
          {count} local skill{count === 1 ? "" : "s"} found under{" "}
          <code className="font-mono">.claude/</code>, none adopted yet
        </div>
        <div className="text-sm text-fg-secondary mt-1 max-w-md">
          Adopting a local skill tells astack to track it — surfaces it in
          this tab, detects drift on Rescan, and lets you Unadopt it later.
          Adopting never moves or rewrites files.
        </div>
      </div>
      <button
        type="button"
        onClick={onAdopt}
        className="h-8 px-3 text-sm inline-flex items-center gap-1.5 rounded-md bg-accent text-accent-fg hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60 transition-colors duration-fast"
      >
        Review &amp; Adopt
      </button>
    </div>
  );
}

function LocalSkillGroup({
  title,
  description,
  tagText,
  rows,
  onUnadopt
}: {
  title: string;
  description: string;
  tagText: string;
  rows: LocalSkill[];
  onUnadopt: (
    entry: { type: SkillType; name: string },
    options: { delete_files: boolean }
  ) => Promise<UnadoptLocalSkillsResult>;
}): React.JSX.Element {
  return (
    <section aria-label={title} className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-fg-secondary">
          {title}
          <span className="ml-2 text-xs text-fg-tertiary tabular">
            {rows.length}
          </span>
        </h3>
        <span className="text-xs text-fg-tertiary max-w-[60ch] truncate">
          {description}
        </span>
      </div>
      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-fg-tertiary text-xs">
              <th className="font-normal px-3 py-2 w-[140px]">State</th>
              <th className="font-normal px-3 py-2">
                {title.replace(/s$/, "")}
              </th>
              <th className="font-normal px-3 py-2 w-[96px]">Origin</th>
              <th className="font-normal px-3 py-2 w-[240px]">Path</th>
              <th className="font-normal px-3 py-2 w-[128px]" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <LocalSkillRow
                key={row.id}
                row={row}
                tagText={tagText}
                onUnadopt={onUnadopt}
              />
            ))}
          </tbody>
        </table>
      </Card>
    </section>
  );
}

function LocalSkillRow({
  row,
  tagText,
  onUnadopt
}: {
  row: LocalSkill;
  tagText: string;
  onUnadopt: (
    entry: { type: SkillType; name: string },
    options: { delete_files: boolean }
  ) => Promise<UnadoptLocalSkillsResult>;
}): React.JSX.Element {
  const info = LOCAL_SKILL_STATUS_INFO[row.status];
  const [unadopting, setUnadopting] = useState(false);

  async function handleUnadopt(): Promise<void> {
    if (unadopting) return;
    // Simple two-step confirm: confirm unadopt, then ask whether to also
    // delete the file on disk. Tests assert the default for "delete on
    // disk?" stays false (non-destructive by default).
    const ok = window.confirm(
      `Unadopt ${row.type} "${row.name}"? astack will stop tracking it. The file on disk is not removed.`
    );
    if (!ok) return;
    const deleteFiles = window.confirm(
      `Also delete the file on disk (${row.rel_path})? Choose Cancel to keep the file.`
    );
    setUnadopting(true);
    try {
      await onUnadopt(
        { type: row.type, name: row.name },
        { delete_files: deleteFiles }
      );
    } finally {
      setUnadopting(false);
    }
  }

  return (
    <tr className="border-t border-line-subtle hover:bg-surface-1 transition-colors duration-fast">
      <td className="px-3 py-2 align-middle">
        <Badge
          tone={info.tone}
          title={info.tooltip ?? undefined}
          aria-label={`Status: ${info.label}`}
        >
          {info.label}
        </Badge>
      </td>
      <td className="px-3 py-2 align-middle font-mono text-xs text-fg-primary">
        <span className="inline-flex items-center gap-1.5">
          {row.name}
          <Badge tone="neutral">{tagText}</Badge>
        </span>
        {row.description ? (
          <div className="mt-0.5 text-fg-tertiary font-sans text-xs max-w-[52ch] line-clamp-1">
            {row.description}
          </div>
        ) : null}
      </td>
      <td className="px-3 py-2 align-middle text-xs">
        {row.origin === "auto" ? (
          <Badge tone="neutral" title="Auto-adopted from existing .claude/">
            auto
          </Badge>
        ) : (
          <Badge tone="accent" title="Manually adopted">
            adopted
          </Badge>
        )}
      </td>
      <td className="px-3 py-2 align-middle font-mono text-xs text-fg-tertiary truncate max-w-[240px]">
        {row.rel_path}
      </td>
      <td className="px-3 py-2 align-middle text-right">
        <button
          type="button"
          onClick={handleUnadopt}
          disabled={unadopting}
          className="h-7 px-2 text-xs text-fg-tertiary hover:text-error focus-visible:ring-2 focus-visible:ring-accent/60 transition-colors duration-fast disabled:opacity-50 disabled:cursor-not-allowed"
          aria-label={`Unadopt ${row.name}`}
        >
          {unadopting ? "Unadopting…" : "Unadopt"}
        </button>
      </td>
    </tr>
  );
}
