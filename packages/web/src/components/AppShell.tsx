import type * as React from "react";
/**
 * AppShell — overall layout (sidebar + content area).
 *
 * Also mounts global hotkeys:
 *   ⌘K / Ctrl+K  — open command palette
 *   ⌘1 .. ⌘5     — jump between primary sections
 *   R            — refresh current data (pages opt-in via event)
 */

import { useCallback, useEffect, useState } from "react";
import { Outlet, useNavigate } from "react-router-dom";

import { api } from "../lib/api.js";
import { useEventListener } from "../lib/sse.js";

import { CommandPalette } from "./CommandPalette.js";
import { Sidebar } from "./Sidebar.js";

export function AppShell(): React.JSX.Element {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [badges, setBadges] = useState({
    repos: 0,
    projects: 0,
    attention: 0
  });
  const navigate = useNavigate();

  const refreshBadges = useCallback(async () => {
    try {
      const [repos, projects] = await Promise.all([
        api.listRepos({ limit: 1 }),
        api.listProjects({ limit: 100 })
      ]);
      // Attention count = projects × non-synced skills. For sidebar badge
      // we just show total project count and compute attention async.
      let attention = 0;
      await Promise.all(
        projects.projects.map(async (p) => {
          try {
            const st = await api.projectStatus(p.id);
            attention += st.subscriptions.filter(
              (s) => s.state !== "synced"
            ).length;
          } catch {
            /* ignore per-project errors */
          }
        })
      );
      setBadges({
        repos: repos.total,
        projects: projects.total,
        attention
      });
    } catch {
      // Daemon unreachable: badges stay 0 and SSE status dot shows offline.
    }
  }, []);

  // Initial load + reload on any SSE event that might affect counts.
  useEffect(() => {
    void refreshBadges();
  }, [refreshBadges]);

  useEventListener("repo.registered", () => void refreshBadges());
  useEventListener("repo.removed", () => void refreshBadges());
  useEventListener("project.registered", () => void refreshBadges());
  useEventListener("project.removed", () => void refreshBadges());
  useEventListener("skill.updated", () => void refreshBadges());
  useEventListener("conflict.detected", () => void refreshBadges());
  useEventListener("sync.completed", () => void refreshBadges());

  // Global hotkeys.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (mod && e.key === "1") {
        e.preventDefault();
        navigate("/");
      } else if (mod && e.key === "2") {
        e.preventDefault();
        navigate("/repos");
      } else if (mod && e.key === "3") {
        e.preventDefault();
        navigate("/projects");
      } else if (mod && e.key === "4") {
        e.preventDefault();
        navigate("/matrix");
      } else if (mod && e.key === "5") {
        e.preventDefault();
        navigate("/settings");
      } else if (mod && e.key.toLowerCase() === "r") {
        e.preventDefault();
        void refreshBadges();
        // pages can listen to this custom event and refetch.
        window.dispatchEvent(new CustomEvent("astack:refresh"));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, refreshBadges]);

  return (
    <div className="flex h-full min-w-[1280px]">
      <Sidebar badges={badges} />
      <main
        className="flex-1 overflow-auto"
        role="main"
        aria-label="Main content"
      >
        <div className="max-w-content-max mx-auto px-6 py-6">
          <Outlet />
        </div>
      </main>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  );
}
