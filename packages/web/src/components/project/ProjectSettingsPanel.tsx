import type * as React from "react";

import type { Project } from "@astack/shared";
import { useEffect, useState } from "react";

import { Button, Card } from "../ui/index.js";

/**
 * ProjectSettingsPanel — the Settings tab.
 *
 * v0.3 scope (spec § Out of scope):
 *   - Auto-sync on window focus (toggle, stored in localStorage per project)
 *   - Primary tool dir display (read-only; CLI-only to change in v0.3)
 *   - Unregister project (destructive, confirm)
 *
 * Auto-sync is localStorage so it survives refresh but doesn't need a
 * server change. v0.4 might move it to project.settings.json if users
 * want it to sync across machines.
 */

export interface ProjectSettingsPanelProps {
  project: Project;
  onUnregister: () => void | Promise<void>;
}

function autoSyncKey(id: number): string {
  return `astack:project:${id}:auto_sync`;
}

/** Read the stored preference. Defaults to true (design review recommendation). */
function readAutoSync(id: number): boolean {
  try {
    const raw = localStorage.getItem(autoSyncKey(id));
    if (raw === null) return true;
    return raw === "1";
  } catch {
    // SSR / privacy mode / quota — fall back to "on" so reload doesn't
    // silently change behavior.
    return true;
  }
}

export function ProjectSettingsPanel({
  project,
  onUnregister
}: ProjectSettingsPanelProps): React.JSX.Element {
  const [autoSync, setAutoSync] = useState(() => readAutoSync(project.id));

  useEffect(() => {
    try {
      localStorage.setItem(autoSyncKey(project.id), autoSync ? "1" : "0");
    } catch {
      // Silently ignore — if storage failed, toggle is at least in-memory
      // correct for this session.
    }
  }, [project.id, autoSync]);

  return (
    <section className="space-y-6 pt-5">
      <h2 className="text-sm font-medium text-fg-secondary">
        Project Settings
      </h2>

      <Card className="px-4 py-3">
        <SettingsRow
          title="Auto-sync on focus"
          description="Re-pull subscribed skills when this tab regains focus. Recommended."
        >
          <Toggle
            checked={autoSync}
            onChange={setAutoSync}
            label="Auto-sync on focus"
          />
        </SettingsRow>
      </Card>

      <Card className="px-4 py-3 space-y-3">
        <SettingsRow
          title="Primary tool directory"
          description="The canonical dir where skills live (other tools symlink to it)."
        >
          <code className="font-mono text-xs text-fg-primary">
            {project.primary_tool}
          </code>
        </SettingsRow>
        <div className="text-xs text-fg-tertiary pt-1">
          Changing this is CLI-only in v0.3.
        </div>
      </Card>

      <div className="border border-error/30 rounded-lg p-4 bg-error/5">
        <div className="text-sm font-semibold text-error">Danger zone</div>
        <div className="text-xs text-fg-secondary mt-1 max-w-md">
          Unregistering removes this project from astack but does NOT touch
          your working copy. Subscriptions and sync history for this project
          will be deleted from the database.
        </div>
        <div className="mt-3">
          <Button
            variant="danger"
            onClick={() => {
              if (
                !confirm(
                  `Unregister ${project.name}? This removes astack's record; your files are untouched.`
                )
              ) {
                return;
              }
              void onUnregister();
            }}
          >
            Unregister project
          </Button>
        </div>
      </div>
    </section>
  );
}

// ---------- sub-components ----------

function SettingsRow({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-fg-primary">{title}</div>
        <div className="text-xs text-fg-tertiary mt-0.5 max-w-md">
          {description}
        </div>
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={[
        "relative inline-flex h-5 w-9 rounded-full transition-colors duration-fast",
        "focus-visible:ring-2 focus-visible:ring-accent/60",
        checked ? "bg-accent" : "bg-surface-2 border border-line-subtle"
      ].join(" ")}
    >
      <span
        aria-hidden
        className={[
          "absolute top-0.5 w-4 h-4 rounded-full bg-fg-primary transition-transform duration-fast",
          checked ? "translate-x-4" : "translate-x-0.5"
        ].join(" ")}
      />
    </button>
  );
}
