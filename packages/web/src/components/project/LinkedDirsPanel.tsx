import type * as React from "react";

import type {
  PrimaryToolStatus,
  Project,
  LinkedDir,
  LinkedDirBrokenReason
} from "@astack/shared";
import { useRef, useState } from "react";

import { Button, Card, IconButton, StatusDot, type StatusTone } from "../ui/index.js";
import { relativeTime } from "../../lib/format.js";

/**
 * LinkedDirsPanel — the Linked Dirs tab body.
 *
 * v0.3 design review problem: "Linked Dirs" section used to be three
 * unlabeled buttons (+ cursor / + codebuddy / + windsurf) with no way
 * to see where each symlink actually pointed or why a broken one was
 * broken. This panel fixes all of that.
 *
 * Each linked dir shows:
 *   - status (active / broken / removed) with a descriptive tone dot
 *   - target_path (→ /absolute/path) so users confirm what they linked
 *   - broken_reason when broken (target_missing / not_a_symlink / perm)
 *   - Unlink button (primary for broken, ghost for active)
 *
 * v0.4 patch: the project's primary tool dir itself (e.g. `.claude`) is
 * rendered as a special "Primary" row at the top. It's the target of
 * every symlink but isn't one itself; users can see its initialization
 * state (initialized/empty/missing) alongside the linked dirs. No
 * Unlink button — you can't unlink the source of truth.
 *
 * Add flow is a dropdown instead of three buttons — avoids the AI-slop
 * 3-button grid and leaves room for a future "Custom path…" option
 * (tracked as post-v0.3 work).
 */

export interface LinkedDirsPanelProps {
  project: Project;
  links: LinkedDir[];
  onAdd: (toolName: string) => void | Promise<void>;
  onRemove: (toolName: string) => void | Promise<void>;
}

const KNOWN_TOOLS = ["cursor", "codebuddy", "windsurf"] as const;

export function LinkedDirsPanel({
  project,
  links,
  onAdd,
  onRemove
}: LinkedDirsPanelProps): React.JSX.Element {
  const linkedNames = new Set(links.map((l) => l.tool_name));
  const canAdd = KNOWN_TOOLS.filter((t) => !linkedNames.has(t));
  // Primary row is always visible — it's conceptually the "0th entry"
  // (the target everything else points at). It counts toward the
  // header total so users see "Linked Dirs 2" instead of 1+phantom.
  const totalCount = links.length + 1;

  return (
    <section className="space-y-3 pt-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-fg-secondary">
          Linked Dirs
          <span className="ml-2 text-xs text-fg-tertiary tabular">
            {totalCount}
          </span>
        </h2>
        <AddLinkMenu options={canAdd} onSelect={onAdd} />
      </div>

      <div className="space-y-2">
        <PrimaryToolRow project={project} />
        {links.length === 0 ? (
          <div className="flex flex-col items-start gap-3 py-8 px-6 border border-dashed border-line-subtle rounded-lg">
            <div>
              <div className="text-base font-semibold text-fg-primary">
                Link a dir to share your skills
              </div>
              <div className="text-sm text-fg-secondary mt-1 max-w-md">
                Astack symlinks{" "}
                <code className="font-mono text-fg-primary">.cursor/</code>,{" "}
                <code className="font-mono text-fg-primary">.codebuddy/</code>,{" "}
                <code className="font-mono text-fg-primary">.codex/</code>,{" "}
                <code className="font-mono text-fg-primary">.gemini/</code>, and{" "}
                <code className="font-mono text-fg-primary">.windsurf/</code> to
                your project&apos;s{" "}
                <code className="font-mono text-fg-primary">
                  {project.primary_tool}/
                </code>{" "}
                dir so every AI tool sees the same skills.
              </div>
            </div>
          </div>
        ) : (
          links.map((l) => (
            <LinkedDirCard key={l.id} link={l} onRemove={onRemove} />
          ))
        )}
      </div>
    </section>
  );
}

// ---------- PrimaryToolRow ----------

/**
 * The canonical tool dir (default `.claude`) rendered as a list item.
 *
 * Visually matches LinkedDirCard so the list reads as homogeneous, but:
 *   - a "Primary" tag replaces the status label
 *   - no Unlink button (can't unlink the source of truth)
 *   - `target_path` is itself — no arrow / resolution line
 *   - status dot comes from primary_tool_status (initialized/empty/missing)
 *
 * Rationale: users who see only `.cursor` in the list were confused
 * about where the actual skills live. Surfacing the primary dir in
 * the same list makes the "everything points here" model literal.
 */
function PrimaryToolRow({
  project
}: {
  project: Project;
}): React.JSX.Element {
  const meta = describePrimary(project.primary_tool_status);
  const displayName = project.primary_tool.replace(/^\./, "");
  const absPath = `${project.path.replace(/\/$/, "")}/${project.primary_tool}`;

  return (
    <Card className="px-4 py-3 border-accent/20 bg-accent/[0.03]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm">
            <StatusDot tone={meta.tone} />
            <span className="font-semibold text-fg-primary">
              {displayName}
            </span>
            <span className="text-xs text-fg-tertiary font-mono">
              {project.primary_tool}
            </span>
            <span className="text-[10px] uppercase tracking-wide font-medium text-accent bg-accent/10 border border-accent/30 rounded px-1.5 py-0.5 ml-1">
              Primary
            </span>
            <span className="text-xs text-fg-tertiary ml-1">{meta.label}</span>
          </div>
          <div className="mt-1 text-xs text-fg-tertiary">
            <code className="font-mono text-fg-secondary">{absPath}</code>
          </div>
          {meta.hint && (
            <div className="mt-1 text-xs text-fg-tertiary italic">
              {meta.hint}
            </div>
          )}
        </div>
        <div className="text-xs text-fg-quaternary pt-0.5 select-none">
          source of truth
        </div>
      </div>
    </Card>
  );
}

interface PrimaryMeta {
  tone: StatusTone;
  label: string;
  hint: string | null;
}

function describePrimary(status: PrimaryToolStatus | null): PrimaryMeta {
  // `null` only from legacy code paths that predate primary_tool_status.
  // Show neutral muted dot rather than guessing.
  if (status === null) {
    return { tone: "muted", label: "unknown", hint: null };
  }
  switch (status) {
    case "initialized":
      return { tone: "accent", label: "initialized", hint: null };
    case "empty":
      return {
        tone: "warn",
        label: "empty",
        hint: "Directory exists but no skills or commands yet."
      };
    case "missing":
      return {
        tone: "hollow",
        label: "missing",
        hint: "Directory does not exist on disk."
      };
    default: {
      const _exhaustive: never = status;
      return { tone: "muted", label: String(_exhaustive), hint: null };
    }
  }
}

// ---------- LinkedDirCard ----------

function LinkedDirCard({
  link,
  onRemove
}: {
  link: LinkedDir;
  onRemove: (toolName: string) => void | Promise<void>;
}): React.JSX.Element {
  const tone =
    link.status === "active"
      ? "accent"
      : link.status === "broken"
        ? "error"
        : "muted";

  return (
    <Card className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm">
            <StatusDot tone={tone} />
            <span className="font-semibold text-fg-primary">
              {link.tool_name}
            </span>
            <span className="text-xs text-fg-tertiary font-mono">
              {link.dir_name}
            </span>
            <span className="text-xs text-fg-tertiary ml-1">
              {statusLabel(link.status)}
            </span>
          </div>
          <div className="mt-1 text-xs text-fg-tertiary">
            {link.target_path ? (
              <span>
                <span className="text-fg-quaternary">→</span>{" "}
                <code className="font-mono text-fg-secondary">
                  {link.target_path}
                </code>
              </span>
            ) : (
              <span className="italic">target unknown</span>
            )}
          </div>
          {link.status === "broken" && link.broken_reason ? (
            <div className="mt-1.5 text-xs text-error">
              {brokenReasonMessage(link.broken_reason)}
            </div>
          ) : null}
          <div className="mt-1 text-xs text-fg-quaternary">
            linked {relativeTime(link.created_at)}
          </div>
        </div>
        <Button
          size="sm"
          variant={link.status === "broken" ? "primary" : "ghost"}
          onClick={() => onRemove(link.tool_name)}
          className={link.status !== "broken" ? "text-fg-tertiary hover:text-error" : ""}
        >
          {link.status === "broken" ? "Unlink" : "Unlink"}
        </Button>
      </div>
    </Card>
  );
}

function statusLabel(status: LinkedDir["status"]): string {
  switch (status) {
    case "active":
      return "active";
    case "broken":
      return "broken";
    case "removed":
      return "removed";
  }
}

function brokenReasonMessage(r: LinkedDirBrokenReason): string {
  switch (r) {
    case "target_missing":
      return "Target directory no longer exists. Unlink + re-add to fix.";
    case "not_a_symlink":
      return "A real file or directory is blocking the symlink. Clean it up and re-link.";
    case "permission_denied":
      return "Permission denied reading the link. Check directory ownership.";
  }
}

// ---------- AddLinkMenu ----------

function AddLinkMenu({
  options,
  onSelect
}: {
  options: readonly string[];
  onSelect: (tool: string) => void | Promise<void>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  if (options.length === 0) {
    return (
      <span className="text-xs text-fg-tertiary">
        All known tools are linked
      </span>
    );
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="h-8 px-3 text-sm inline-flex items-center gap-1 rounded-md bg-surface-1 text-fg-primary border border-line-subtle hover:bg-surface-2 hover:border-line focus-visible:ring-2 focus-visible:ring-accent/60"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        + Link a dir <span className="text-fg-tertiary">▾</span>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-9 z-10 min-w-[160px] py-1 bg-surface-3 border border-line rounded-md shadow-xl shadow-black/30 backdrop-blur"
        >
          {options.map((tool) => (
            <button
              key={tool}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void onSelect(tool);
              }}
              className="w-full text-left px-3 h-7 flex items-center text-sm text-fg-primary hover:bg-surface-2"
            >
              + {tool}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// IconButton imported but not used inline — tree-shake safe. Kept in the
// import list because a future follow-up wants it for the ⋯ menu.
void IconButton;
