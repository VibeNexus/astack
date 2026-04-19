import type * as React from "react";
/**
 * Projects page — list projects and register new ones.
 */

import type { Project } from "@astack/shared";
import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  Skeleton
} from "../components/ui.js";
import { api, AstackError } from "../lib/api.js";
import { useEventListener } from "../lib/sse.js";
import { useToast } from "../lib/toast.js";

export function ProjectsPage(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [params, setParams] = useSearchParams();
  const showDialog = params.get("action") === "new";
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const { projects: list } = await api.listProjects({ limit: 500 });
      setProjects(list);
    } catch (err) {
      toast.error(
        "Could not load projects",
        err instanceof AstackError ? err.message : String(err)
      );
      setProjects([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEventListener("project.registered", () => void load());
  useEventListener("project.removed", () => void load());

  async function handleDelete(project: Project): Promise<void> {
    if (!confirm(`Unregister project "${project.name}"?`)) return;
    try {
      await api.deleteProject(project.id);
      toast.ok(`Unregistered '${project.name}'`);
      await load();
    } catch (err) {
      toast.error(
        "Unregister failed",
        err instanceof AstackError ? err.message : String(err)
      );
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <Button
          variant="primary"
          onClick={() => setParams({ action: "new" })}
        >
          Register project
        </Button>
      </div>

      {projects === null ? (
        <div className="space-y-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          title="No projects registered"
          hint="Run 'astack init' in your project root, or use the button on the right."
        >
          <Button
            variant="primary"
            onClick={() => setParams({ action: "new" })}
          >
            Register your first project
          </Button>
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {projects.map((p) => (
            <Card
              key={p.id}
              className="flex items-center justify-between py-3 px-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Link
                    to={`/projects/${p.id}`}
                    className="font-medium hover:text-accent"
                  >
                    {p.name}
                  </Link>
                  <Badge tone="neutral">id {p.id}</Badge>
                </div>
                <div className="text-xs text-text-muted font-mono truncate mt-0.5">
                  {p.path}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Link to={`/projects/${p.id}`}>
                  <Button size="sm">Open</Button>
                </Link>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleDelete(p)}
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
        <RegisterProjectDialog
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

function RegisterProjectDialog({
  onClose,
  onRegistered
}: {
  onClose: () => void;
  onRegistered: () => void;
}): React.JSX.Element {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function submit(): Promise<void> {
    if (!path.trim()) return;
    setBusy(true);
    try {
      await api.registerProject({ path: path.trim() });
      toast.ok("Project registered");
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
      <div className="w-[480px] max-w-[90vw] bg-elevated border border-border rounded p-4 space-y-3">
        <div className="text-lg font-semibold">Register project</div>
        <div className="text-sm text-text-secondary">
          Or, from your project root:{" "}
          <span className="font-mono">astack init</span>
        </div>
        <label className="block text-sm">
          <div className="text-text-secondary mb-1">Absolute path</div>
          <input
            className="w-full bg-surface border border-border rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
            placeholder="/Users/you/code/my-project"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            disabled={busy}
            autoFocus
          />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || !path}>
            {busy ? "Registering…" : "Register"}
          </Button>
        </div>
      </div>
    </div>
  );
}
