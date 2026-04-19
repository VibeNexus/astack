import type * as React from "react";
/**
 * Resolve page — three-column conflict resolver.
 *
 * Per design review decision 7.2: single URL /resolve/:project_id/:skill_id
 * accessible from everywhere a conflict appears.
 *
 * Three strategies (decision 1 in Implementation TODOs):
 *   - Use Remote    — overwrite working copy with upstream
 *   - Keep Local    — push working copy to upstream
 *   - Manual merge  — user edits the working file; come back with
 *                     --done once conflict markers are gone.
 */

import {
  ResolveStrategy,
  type GetProjectStatusResponse,
  type SubscriptionWithState
} from "@astack/shared";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { Button, Card, Skeleton } from "../components/ui.js";
import { api, AstackError } from "../lib/api.js";
import { shortHash } from "../lib/format.js";
import { useToast } from "../lib/toast.js";

export function ResolvePage(): React.JSX.Element {
  const { project_id, skill_id } = useParams<{
    project_id: string;
    skill_id: string;
  }>();
  const projectId = Number(project_id);
  const skillId = Number(skill_id);
  const navigate = useNavigate();
  const [status, setStatus] = useState<GetProjectStatusResponse | null>(null);
  const [sub, setSub] = useState<SubscriptionWithState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await api.projectStatus(projectId);
      setStatus(res);
      const found =
        res.subscriptions.find((s) => s.skill.id === skillId) ?? null;
      setSub(found);
    } catch (err) {
      setError(
        err instanceof AstackError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      );
    }
  }, [projectId, skillId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runStrategy(
    strategy: typeof ResolveStrategy[keyof typeof ResolveStrategy],
    manualDone = false
  ): Promise<void> {
    setBusy(true);
    try {
      await api.resolve(projectId, {
        skill_id: skillId,
        strategy,
        manual_done: manualDone
      });
      toast.ok(`Resolved via ${strategy}`);
      navigate(`/projects/${projectId}`);
    } catch (err) {
      toast.error(
        "Resolve failed",
        err instanceof AstackError ? err.message : String(err)
      );
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="space-y-3">
        <div className="text-sm text-error">{error}</div>
        <Link to="/" className="text-sm underline text-text-secondary">
          ← back to Sync Status
        </Link>
      </div>
    );
  }

  if (!status || !sub) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-60" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (sub.state !== "conflict") {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          No active conflict
        </h1>
        <p className="text-sm text-text-secondary">
          {sub.skill.name} in {status.project.name} is currently{" "}
          <span className="text-text-primary">{sub.state}</span>.
        </p>
        <Link
          to={`/projects/${projectId}`}
          className="text-sm underline text-text-secondary"
        >
          ← back to project
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          to={`/projects/${projectId}`}
          className="text-xs text-text-muted hover:text-text-secondary"
        >
          ← {status.project.name}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">
          Resolve conflict — {sub.skill.name}
        </h1>
        <p className="text-sm text-text-secondary mt-1">
          {sub.state_detail ??
            "Local working copy and upstream have both changed since the last sync."}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <StrategyCard
          title="Keep local"
          description="Overwrite upstream with your working copy. Publishes your version."
          cta="Keep local & push"
          busy={busy}
          disabledReason={
            sub.repo.kind === "open-source"
              ? "Disabled for open-source repos (push not allowed)."
              : undefined
          }
          onRun={() => runStrategy(ResolveStrategy.KeepLocal)}
        />
        <StrategyCard
          title="Use remote"
          description="Discard local changes and pull the upstream version into the working copy."
          cta="Use remote"
          busy={busy}
          destructive
          onRun={() => runStrategy(ResolveStrategy.UseRemote)}
        />
        <ManualCard
          busy={busy}
          disabledReason={
            sub.repo.kind === "open-source"
              ? "Disabled for open-source repos (push not allowed)."
              : undefined
          }
          onRun={() => runStrategy(ResolveStrategy.Manual, true)}
        />
      </div>

      <Card className="text-xs text-text-muted space-y-1">
        <div>
          Upstream version:{" "}
          <span className="font-mono text-text-secondary">
            {shortHash(sub.skill.version)}
          </span>
        </div>
        <div>
          Working copy lives at{" "}
          <span className="font-mono">
            {status.project.path}/{status.project.primary_tool}/
            {sub.skill.path}
          </span>
        </div>
      </Card>
    </div>
  );
}

function StrategyCard({
  title,
  description,
  cta,
  busy,
  destructive,
  disabledReason,
  onRun
}: {
  title: string;
  description: string;
  cta: string;
  busy: boolean;
  destructive?: boolean;
  disabledReason?: string;
  onRun: () => void;
}): React.JSX.Element {
  const blocked = Boolean(disabledReason);
  return (
    <Card className="flex flex-col gap-3">
      <div>
        <div className="text-lg font-medium">{title}</div>
        <div className="text-sm text-text-secondary mt-1">{description}</div>
        {disabledReason ? (
          <div className="text-xs text-warn mt-2">{disabledReason}</div>
        ) : null}
      </div>
      <Button
        variant={destructive ? "outline" : "primary"}
        onClick={onRun}
        disabled={busy || blocked}
        className={destructive ? "text-error hover:text-error" : ""}
      >
        {busy ? "Working…" : cta}
      </Button>
    </Card>
  );
}

function ManualCard({
  busy,
  disabledReason,
  onRun
}: {
  busy: boolean;
  disabledReason?: string;
  onRun: () => void;
}): React.JSX.Element {
  const blocked = Boolean(disabledReason);
  return (
    <Card className="flex flex-col gap-3">
      <div>
        <div className="text-lg font-medium">Manual merge</div>
        <div className="text-sm text-text-secondary mt-1">
          Edit the file in your editor, remove any conflict markers, then
          click the button below. Astack verifies and pushes.
        </div>
        {disabledReason ? (
          <div className="text-xs text-warn mt-2">{disabledReason}</div>
        ) : null}
      </div>
      <Button variant="outline" onClick={onRun} disabled={busy || blocked}>
        {busy ? "Working…" : "I finished merging"}
      </Button>
    </Card>
  );
}
