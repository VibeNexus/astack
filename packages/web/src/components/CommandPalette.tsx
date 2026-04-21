import type * as React from "react";
/**
 * Command palette (⌘K / Ctrl+K).
 *
 * Per design review decision 6: first-class keyboard navigation. The
 * palette fuzzy-matches against a static list of commands (pages +
 * common actions). Not a plugin system; intentionally curated.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { Kbd } from "./ui/index.js";

interface PaletteCommand {
  label: string;
  hint?: string;
  run: () => void;
  keywords?: string[];
}

export function CommandPalette({
  open,
  onClose
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // v0.3: extract current project id from the URL if we're on a project
  // detail route. Lets us surface project-specific actions in the palette.
  const projectDetailMatch = useMemo(() => {
    const m = location.pathname.match(/^\/projects\/(\d+)/);
    return m ? { projectId: Number(m[1]!) } : null;
  }, [location.pathname]);

  const commands: PaletteCommand[] = useMemo(() => {
    const list: PaletteCommand[] = [
      {
        label: "Go to Sync Status",
        hint: "⌘1",
        run: () => navigate("/"),
        keywords: ["home", "dashboard"]
      },
      {
        label: "Go to Repos",
        hint: "⌘2",
        run: () => navigate("/repos")
      },
      {
        label: "Go to Projects",
        hint: "⌘3",
        run: () => navigate("/projects")
      },
      {
        label: "Go to Matrix",
        hint: "⌘4",
        run: () => navigate("/matrix"),
        keywords: ["skill matrix", "cross project", "grid"]
      },
      {
        label: "Go to Settings",
        hint: "⌘5",
        run: () => navigate("/settings")
      },
      {
        label: "Register new repo",
        run: () => navigate("/repos?action=new")
      },
      {
        label: "Register new project",
        run: () => navigate("/projects?action=new")
      }
    ];

    // v0.3: project-detail context surfaces direct jumps to each tab.
    // We can't programmatically open the BrowseSkillsDrawer from here
    // without leaking page state into global — instead, navigate to the
    // Subscriptions tab and leave the user one click away.
    if (projectDetailMatch) {
      const pid = projectDetailMatch.projectId;
      list.push(
        {
          label: "Subscriptions tab",
          run: () => navigate(`/projects/${pid}`),
          keywords: ["subscribe", "skill"]
        },
        {
          label: "Linked Dirs tab",
          run: () => navigate(`/projects/${pid}?tab=tools`),
          keywords: ["link", "symlink", "cursor", "codebuddy", "windsurf"]
        },
        {
          label: "Sync History tab",
          run: () => navigate(`/projects/${pid}?tab=history`),
          keywords: ["log", "audit"]
        },
        {
          label: "Project Settings tab",
          run: () => navigate(`/projects/${pid}?tab=settings`),
          keywords: ["unregister", "auto-sync"]
        }
      );
    }

    return list;
  }, [navigate, projectDetailMatch]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => {
      const hay = [c.label, ...(c.keywords ?? []), c.hint ?? ""]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [commands, query]);

  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      // Focus input next tick.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  function handleKey(e: React.KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[cursor];
      if (cmd) {
        cmd.run();
        onClose();
      }
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 bg-base/60 flex items-start justify-center pt-[15vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        className="w-[520px] max-w-[90vw] bg-overlay border border-border rounded shadow-xl overflow-hidden"
        onKeyDown={handleKey}
      >
        <div className="border-b border-border px-3">
          <input
            ref={inputRef}
            className="w-full bg-transparent py-3 text-sm focus:outline-none placeholder:text-text-muted"
            placeholder="Type a command…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="max-h-[320px] overflow-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-sm text-text-muted text-center">
              No matches
            </div>
          ) : (
            filtered.map((cmd, i) => (
              <button
                key={cmd.label}
                className={`w-full flex items-center justify-between text-left px-3 py-2 text-sm ${
                  i === cursor
                    ? "bg-surface text-text-primary"
                    : "text-text-secondary hover:bg-surface"
                }`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => {
                  cmd.run();
                  onClose();
                }}
              >
                <span>{cmd.label}</span>
                {cmd.hint ? <Kbd>{cmd.hint}</Kbd> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
