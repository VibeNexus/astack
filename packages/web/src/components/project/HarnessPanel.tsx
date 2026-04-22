import type * as React from "react";

import { HarnessStatus, type ProjectHarnessState } from "@astack/shared";
import { useCallback, useEffect, useState } from "react";

import { api, AstackError } from "../../lib/api.js";
import { useEventListener } from "../../lib/sse.js";
import { useToast } from "../../lib/toast.js";
import {
  Badge,
  Button,
  Card,
  Skeleton,
  StatusDot,
  type StatusTone
} from "../ui/index.js";

/**
 * Harness tab — v0.4, extended in v0.7.
 *
 * Displays the installation status of the system-level `harness-init` skill
 * inside this project plus the project-level governance scaffold
 * (AGENTS.md + docs/version/ + docs/retro/) required by `/spec` et al.
 *
 * Five possible states:
 *
 *   - installed            (skill hash matches built-in AND every scaffold
 *                           file exists)
 *   - scaffold_incomplete  (skill OK but governance files missing — user
 *                           needs to run `/init_harness` in the AI chat)
 *   - drift                (seed dir present but user modified it — will
 *                           be overwritten on next Re-install)
 *   - missing              (seed dir absent)
 *   - seed_failed          (last install attempt threw; last_error has
 *                           the reason)
 *
 * Actions:
 *   - "Re-install" button reseeds the built-in skill. This does NOT
 *     materialize AGENTS.md / docs/**; those come from the
 *     `/init_harness` slash command run inside the AI chat. The
 *     instructions panel (toggle via "Show instructions") explains this.
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
      <div className="space-y-1">
        <h2 className="text-sm font-medium text-fg-secondary flex items-center gap-2">
          Harness
          <Badge tone="neutral" title="Bundled with astack — not subscribed from a repo">
            system
          </Badge>
        </h2>
        <p className="text-xs text-fg-tertiary max-w-2xl">
          A built-in system-level <span className="font-medium">skill</span>{" "}
          (<code className="font-mono">harness-init</code>) that lays down the
          governance scaffold (<code className="font-mono">AGENTS.md</code> +{" "}
          <code className="font-mono">docs/version/</code> +{" "}
          <code className="font-mono">docs/retro/</code>). This is different from
          the <code className="font-mono">/init_harness</code> slash{" "}
          <span className="font-medium">command</span>, which runs inside your
          AI coding tool — the skill materializes the shell script, the command
          drives the interactive migration.
        </p>
      </div>

      <Card className="px-4 py-4 space-y-3">
        <StatusRow state={state} />
        {state.scaffold.missing.length > 0 && (
          <ScaffoldMissingBlock missing={state.scaffold.missing} />
        )}
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
            variant={primaryCtaVariant(state.status)}
            onClick={handleInstall}
            disabled={busy}
          >
            {busy ? "Installing…" : primaryCtaLabel(state.status)}
          </Button>
          <Button
            variant="ghost"
            onClick={() => setShowInstructions((v) => !v)}
          >
            {showInstructions ? "Hide instructions" : "Show instructions"}
          </Button>
        </div>

        {showInstructions && <InstructionsBlock status={state.status} />}
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
        detail:
          "The Harness skill is deployed and all governance files (AGENTS.md + docs/version/ + docs/retro/) are in place."
      };
    case HarnessStatus.ScaffoldIncomplete:
      return {
        label: "Scaffold incomplete",
        tone: "warn",
        detail:
          "The Harness skill is installed, but the project is missing required governance files. Open this project in your AI coding tool and run /init_harness in the chat to materialize them."
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
          "The harness-init skill is not present in this project. Click Install to seed it, then run /init_harness in the AI chat to finish setup."
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

function primaryCtaLabel(status: ProjectHarnessState["status"]): string {
  switch (status) {
    case HarnessStatus.Missing:
      return "Install";
    case HarnessStatus.SeedFailed:
      return "Retry install";
    default:
      return "Re-install";
  }
}

function primaryCtaVariant(
  status: ProjectHarnessState["status"]
): "primary" | "default" {
  // Highlight the call-to-action when the user clearly hasn't installed
  // anything yet; Drift / ScaffoldIncomplete use the neutral variant
  // because they're advisory rather than required.
  return status === HarnessStatus.Missing ? "primary" : "default";
}

function ScaffoldMissingBlock({
  missing
}: {
  missing: string[];
}): React.JSX.Element {
  return (
    <div
      className="rounded border border-line-subtle bg-surface-1 px-3 py-2 space-y-1"
      role="group"
      aria-label="Missing scaffold files"
    >
      <div className="text-xs font-medium text-fg-primary">Missing files</div>
      <ul className="text-xs text-fg-secondary space-y-0.5">
        {missing.map((rel) => (
          <li key={rel} className="font-mono break-all">
            {rel}
          </li>
        ))}
      </ul>
    </div>
  );
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

/**
 * Instructions block — v0.7.
 *
 * Harness setup is driven by a slash command inside the AI coding tool
 * chat (e.g. Claude Code / CodeBuddy IDE), not a raw shell command.
 * Running the init script directly from a terminal skips the interactive
 * prompts for project metadata and leaves the AI-migration step unexecuted
 * on existing projects. We present `/init_harness` as the single entry
 * point; the shell script is an implementation detail invoked by that
 * skill.
 *
 * Namespace disambiguation (v0.7 B1):
 *   `/init_harness` is a slash **command** (single `.md` under
 *   `.claude/commands/`) whereas `harness-init` is a directory **skill**
 *   shipped by astack. The command is NOT bundled — users must subscribe
 *   it from a repo that publishes it (e.g. the in-house `astack-skills`
 *   repo). We call this out here so users don't assume `/init_harness`
 *   exists out of the box.
 */
function InstructionsBlock({
  status
}: {
  status: ProjectHarnessState["status"];
}): React.JSX.Element {
  const command = "/init_harness";
  const toast = useToast();
  const copy = (): void => {
    navigator.clipboard
      .writeText(command)
      .then(() => toast.ok("Copied"))
      .catch(() => toast.error("Copy failed"));
  };

  const lead =
    status === HarnessStatus.ScaffoldIncomplete
      ? "Open this project in your AI coding tool (Claude Code, CodeBuddy IDE, etc.) and run the following slash command in the chat to finish Harness initialization (AGENTS.md + docs/version/ + docs/retro/):"
      : "Open this project in your AI coding tool (Claude Code, CodeBuddy IDE, etc.) and run the following slash command in the chat to initialize the Harness governance scaffolding (AGENTS.md + docs/version/ + docs/retro/):";

  return (
    <div className="mt-2 rounded border border-line-subtle bg-surface-1 px-3 py-3 space-y-2">
      <div className="text-xs text-fg-secondary max-w-xl">{lead}</div>
      <div className="flex items-start gap-2">
        <code className="flex-1 text-xs font-mono text-fg-primary bg-base rounded px-2 py-1.5 break-all">
          {command}
        </code>
        <Button variant="ghost" onClick={copy}>
          Copy
        </Button>
      </div>
      <div
        className="rounded border border-line-subtle/50 bg-base/40 px-2.5 py-2 space-y-1"
        role="note"
        aria-label="Prerequisite"
      >
        <div className="text-[11px] font-medium text-fg-secondary">
          Prerequisite
        </div>
        <div className="text-[11px] text-fg-tertiary leading-relaxed">
          <code className="font-mono">/init_harness</code> is a slash{" "}
          <span className="font-medium">command</span> that must be subscribed
          from a repo (e.g. <code className="font-mono">astack-skills</code>).
          It is <span className="font-medium">not</span> bundled with astack.
          If your AI tool says the command is unknown, go to the{" "}
          <span className="font-medium">Subscriptions</span> tab and subscribe
          to a command named <code className="font-mono">init_harness</code>{" "}
          first.
        </div>
      </div>
      <div className="text-[11px] text-fg-tertiary">
        Do not run the underlying shell script by hand — the slash command
        handles both the scaffold rendering and the AI-assisted migration
        for projects that already have an AGENTS.md.
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
