import type * as React from "react";

import { HarnessStatus, type ProjectHarnessState } from "@astack/shared";
import { useCallback, useEffect, useState } from "react";

import { api, AstackError } from "../../lib/api.js";
import { useEventListener } from "../../lib/sse.js";
import { useToast } from "../../lib/toast.js";
import {
  Button,
  Card,
  Skeleton,
  StatusDot,
  type StatusTone
} from "../ui/index.js";

/**
 * Harness tab — v0.4.
 *
 * Displays the installation status of the system-level `harness-init` skill
 * inside this project. Four possible states:
 *
 *   - installed    (hash matches built-in)
 *   - drift        (seed dir present but user modified it — will be overwritten)
 *   - missing      (seed dir absent)
 *   - seed_failed  (last install attempt threw; last_error has the reason)
 *
 * Only action is "Re-install" (aka Install when missing). Built-in version
 * is the source of truth; there is no "keep local" path (v0.4 spec §A2).
 *
 * inspectHarness is a pure read — the tab refreshes via:
 *   - mount (initial load)
 *   - SSE harness.changed
 *   - Re-install button click
 */

interface Props {
  projectId: number;
}

export function HarnessPanel({ projectId }: Props): React.JSX.Element {
  const [state, setState] = useState<ProjectHarnessState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await api.inspectHarness(projectId);
      setState(res);
    } catch (err) {
      setError(
        err instanceof AstackError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      );
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-refresh when the daemon emits harness.changed (e.g. from another
  // client or a retry). Scope to this project only.
  useEventListener("harness.changed", (e) => {
    if (e.payload.project_id === projectId) void load();
  });

  async function handleInstall(): Promise<void> {
    setBusy(true);
    try {
      const res = await api.installHarness(projectId);
      setState(res);
      toast.ok("Harness skill installed");
    } catch (err) {
      const msg =
        err instanceof AstackError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      toast.error("Install failed", msg);
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <section className="space-y-3 pt-5">
        <div className="text-sm text-error">{error}</div>
      </section>
    );
  }

  if (!state) {
    return (
      <section className="space-y-3 pt-5">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-24" />
      </section>
    );
  }

  return (
    <section className="space-y-5 pt-5">
      <h2 className="text-sm font-medium text-fg-secondary">Harness</h2>

      <Card className="px-4 py-4 space-y-3">
        <StatusRow state={state} />
        {state.seeded_at && (
          <MetaRow label="Installed at" value={formatTimestamp(state.seeded_at)} />
        )}
        <MetaRow label="Source" value={state.skill.source_path} mono />
        <MetaRow
          label="Description"
          value={state.skill.description}
        />

        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Button
            variant={state.status === HarnessStatus.Missing ? "primary" : "default"}
            onClick={handleInstall}
            disabled={busy}
          >
            {busy
              ? "Installing…"
              : state.status === HarnessStatus.Missing
                ? "Install"
                : state.status === HarnessStatus.SeedFailed
                  ? "Retry install"
                  : "Re-install"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => setShowInstructions((v) => !v)}
          >
            {showInstructions ? "Hide instructions" : "Show instructions"}
          </Button>
        </div>

        {showInstructions && (
          <InstructionsBlock projectSkillPath="./.claude/skills/harness-init" />
        )}
      </Card>
    </section>
  );
}

// ---------- sub-components ----------

function StatusRow({
  state
}: {
  state: ProjectHarnessState;
}): React.JSX.Element {
  const meta = describeStatus(state);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-sm font-medium text-fg-primary">
        <StatusDot tone={meta.tone} />
        <span>{meta.label}</span>
      </div>
      <div className="text-xs text-fg-secondary max-w-xl">{meta.detail}</div>
      {state.status === HarnessStatus.SeedFailed && state.last_error && (
        <div className="text-xs text-error mt-1 font-mono break-all">
          {state.last_error}
        </div>
      )}
    </div>
  );
}

interface StatusMeta {
  label: string;
  tone: StatusTone;
  detail: string;
}

export function describeStatus(state: ProjectHarnessState): StatusMeta {
  switch (state.status) {
    case HarnessStatus.Installed:
      return {
        label: "Installed",
        tone: "accent",
        detail: "The built-in harness-init skill is deployed in this project."
      };
    case HarnessStatus.Drift:
      return {
        label: "Drift detected",
        tone: "warn",
        detail:
          "Your local copy of this skill has been modified. Astack treats the built-in version as the source of truth — your changes will be overwritten the next time you click Re-install."
      };
    case HarnessStatus.Missing:
      return {
        label: "Not installed",
        tone: "hollow",
        detail:
          "The harness-init skill is not present in this project. Click Install to seed it."
      };
    case HarnessStatus.SeedFailed:
      return {
        label: "Install failed",
        tone: "error",
        detail:
          "The last installation attempt did not complete. Retry when the underlying issue is resolved."
      };
    default: {
      const _exhaustive: never = state.status;
      return {
        label: String(_exhaustive),
        tone: "muted",
        detail: "Unknown status."
      };
    }
  }
}

function MetaRow({
  label,
  value,
  mono
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="text-xs text-fg-tertiary shrink-0 w-28">{label}</div>
      <div
        className={[
          "text-xs text-fg-secondary min-w-0 break-all",
          mono ? "font-mono" : ""
        ].join(" ")}
      >
        {value}
      </div>
    </div>
  );
}

function InstructionsBlock({
  projectSkillPath
}: {
  projectSkillPath: string;
}): React.JSX.Element {
  const command = `bash ${projectSkillPath}/scripts/init-harness.sh`;
  const toast = useToast();
  const copy = (): void => {
    navigator.clipboard
      .writeText(command)
      .then(() => toast.ok("Copied"))
      .catch(() => toast.error("Copy failed"));
  };
  return (
    <div className="mt-2 rounded border border-line-subtle bg-surface-1 px-3 py-3 space-y-2">
      <div className="text-xs text-fg-secondary max-w-xl">
        To initialize Harness governance scaffolding (AGENTS.md +
        docs/version/) in this project, run the following from the project
        root:
      </div>
      <div className="flex items-start gap-2">
        <code className="flex-1 text-xs font-mono text-fg-primary bg-base rounded px-2 py-1.5 break-all">
          {command}
        </code>
        <Button variant="ghost" onClick={copy}>
          Copy
        </Button>
      </div>
      <div className="text-[11px] text-fg-tertiary">
        Uses <code className="font-mono">bash</code> (not <code className="font-mono">./</code>)
        for cross-platform compatibility — exec bits aren&apos;t preserved by
        all install paths.
      </div>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
