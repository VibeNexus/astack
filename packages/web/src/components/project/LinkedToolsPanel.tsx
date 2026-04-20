import type * as React from "react";

import type { ToolLink, ToolLinkBrokenReason } from "@astack/shared";
import { useRef, useState } from "react";

import { Button, Card, IconButton, StatusDot } from "../ui/index.js";
import { relativeTime } from "../../lib/format.js";

/**
 * LinkedToolsPanel — the Linked Tools tab body.
 *
 * v0.3 design review problem: "Linked tools" section used to be three
 * unlabeled buttons (+ cursor / + codebuddy / + windsurf) with no way
 * to see where each symlink actually pointed or why a broken one was
 * broken. This panel fixes all of that.
 *
 * Each tool link shows:
 *   - status (active / broken / removed) with a descriptive tone dot
 *   - target_path (→ /absolute/path) so users confirm what they linked
 *   - broken_reason when broken (target_missing / not_a_symlink / perm)
 *   - Unlink button (primary for broken, ghost for active)
 *
 * Add flow is a dropdown instead of three buttons — avoids the AI-slop
 * 3-button grid and leaves room for a future "Custom path…" option
 * (tracked as post-v0.3 work).
 */

export interface LinkedToolsPanelProps {
  links: ToolLink[];
  onAdd: (toolName: string) => void | Promise<void>;
  onRemove: (toolName: string) => void | Promise<void>;
}

const KNOWN_TOOLS = ["cursor", "codebuddy", "windsurf"] as const;

export function LinkedToolsPanel({
  links,
  onAdd,
  onRemove
}: LinkedToolsPanelProps): React.JSX.Element {
  const linkedNames = new Set(links.map((l) => l.tool_name));
  const canAdd = KNOWN_TOOLS.filter((t) => !linkedNames.has(t));

  return (
    <section className="space-y-3 pt-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-fg-secondary">
          Linked Tools
          <span className="ml-2 text-xs text-fg-tertiary tabular">
            {links.length}
          </span>
        </h2>
        <AddLinkMenu options={canAdd} onSelect={onAdd} />
      </div>

      {links.length === 0 ? (
        <div className="flex flex-col items-start gap-3 py-10 px-6 border border-dashed border-line-subtle rounded-lg">
          <div>
            <div className="text-base font-semibold text-fg-primary">
              Link a tool to share your skills
            </div>
            <div className="text-sm text-fg-secondary mt-1 max-w-md">
              Astack symlinks{" "}
              <code className="font-mono text-fg-primary">.cursor/</code>,{" "}
              <code className="font-mono text-fg-primary">.codebuddy/</code>,
              and{" "}
              <code className="font-mono text-fg-primary">.windsurf/</code> to
              your project's{" "}
              <code className="font-mono text-fg-primary">.claude/</code> dir
              so every AI tool sees the same skills.
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {links.map((l) => (
            <ToolLinkCard key={l.id} link={l} onRemove={onRemove} />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- ToolLinkCard ----------

function ToolLinkCard({
  link,
  onRemove
}: {
  link: ToolLink;
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

function statusLabel(status: ToolLink["status"]): string {
  switch (status) {
    case "active":
      return "active";
    case "broken":
      return "broken";
    case "removed":
      return "removed";
  }
}

function brokenReasonMessage(r: ToolLinkBrokenReason): string {
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
        + Link a tool <span className="text-fg-tertiary">▾</span>
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
