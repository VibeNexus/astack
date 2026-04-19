import type * as React from "react";
/**
 * Repos page — list + register + remove + refresh skill repositories.
 */

import type { SkillRepo } from "@astack/shared";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  Skeleton
} from "../components/ui.js";
import { api, AstackError } from "../lib/api.js";
import { relativeTime, shortHash } from "../lib/format.js";
import { useEventListener } from "../lib/sse.js";
import { useToast } from "../lib/toast.js";

export function ReposPage(): React.JSX.Element {
  const [repos, setRepos] = useState<SkillRepo[] | null>(null);
  const [params, setParams] = useSearchParams();
  const showDialog = params.get("action") === "new";
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const { repos: list } = await api.listRepos({ limit: 200 });
      setRepos(list);
    } catch (err) {
      toast.error(
        "Could not load repos",
        err instanceof AstackError ? err.message : String(err)
      );
      setRepos([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEventListener("repo.registered", () => void load());
  useEventListener("repo.refreshed", () => void load());
  useEventListener("repo.removed", () => void load());

  async function handleRefresh(id: number): Promise<void> {
    try {
      const res = await api.refreshRepo(id);
      toast.ok(
        res.changed
          ? `Repo refreshed — HEAD moved`
          : "Repo refreshed — no changes"
      );
      await load();
    } catch (err) {
      toast.error(
        "Refresh failed",
        err instanceof AstackError ? err.message : String(err)
      );
    }
  }

  async function handleDelete(repo: SkillRepo): Promise<void> {
    if (!confirm(`Remove repo "${repo.name}"?`)) return;
    try {
      await api.deleteRepo(repo.id);
      toast.ok(`Removed repo '${repo.name}'`);
      await load();
    } catch (err) {
      toast.error(
        "Delete failed",
        err instanceof AstackError ? err.message : String(err)
      );
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Repos</h1>
        <Button
          variant="primary"
          onClick={() => setParams({ action: "new" })}
        >
          Register repo
        </Button>
      </div>

      {repos === null ? (
        <div className="space-y-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : repos.length === 0 ? (
        <EmptyState
          title="No repos registered"
          hint="A skill repo is a git repository with commands/ and skills/ directories."
        >
          <Button
            variant="primary"
            onClick={() => setParams({ action: "new" })}
          >
            Register your first repo
          </Button>
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {repos.map((r) => (
            <Card
              key={r.id}
              className="flex items-center justify-between py-3 px-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{r.name}</span>
                  <Badge tone="neutral">id {r.id}</Badge>
                </div>
                <div className="text-xs text-text-muted font-mono truncate mt-0.5">
                  {r.git_url}
                </div>
                <div className="text-xs text-text-muted mt-1 flex items-center gap-3">
                  <span>
                    HEAD{" "}
                    <span className="font-mono">{shortHash(r.head_hash)}</span>
                  </span>
                  <span>Last pulled {relativeTime(r.last_synced)}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => handleRefresh(r.id)}>
                  Refresh
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleDelete(r)}
                  className="text-error hover:text-error"
                >
                  Remove
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {showDialog ? (
        <RegisterRepoDialog
          onClose={() => setParams({})}
          onRegistered={() => {
            setParams({});
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function RegisterRepoDialog({
  onClose,
  onRegistered
}: {
  onClose: () => void;
  onRegistered: () => void;
}): React.JSX.Element {
  const [gitUrl, setGitUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function submit(): Promise<void> {
    if (!gitUrl.trim()) return;
    setBusy(true);
    try {
      const res = await api.registerRepo({
        git_url: gitUrl.trim(),
        name: name.trim() || undefined
      });
      toast.ok(
        `Registered ${res.repo.name}`,
        `${res.command_count} command(s), ${res.skill_count} skill(s)`
      );
      onRegistered();
    } catch (err) {
      toast.error(
        "Registration failed",
        err instanceof AstackError ? err.message : String(err)
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-30 bg-base/60 flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="w-[440px] max-w-[90vw] bg-elevated border border-border rounded p-4 space-y-3">
        <div className="text-lg font-semibold">Register skill repo</div>
        <label className="block text-sm">
          <div className="text-text-secondary mb-1">Git URL</div>
          <input
            className="w-full bg-surface border border-border rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
            placeholder="git@github.com:me/skills.git"
            value={gitUrl}
            onChange={(e) => setGitUrl(e.target.value)}
            disabled={busy}
            autoFocus
          />
        </label>
        <label className="block text-sm">
          <div className="text-text-secondary mb-1">
            Name <span className="text-text-muted">(optional)</span>
          </div>
          <input
            className="w-full bg-surface border border-border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            placeholder="Derived from URL by default"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || !gitUrl}>
            {busy ? "Cloning…" : "Register"}
          </Button>
        </div>
      </div>
    </div>
  );
}
