import type * as React from "react";
/**
 * Left sidebar navigation (240px fixed).
 *
 * Per docs/asset/design.md § Pass 1 Information Architecture:
 *   - Default page = Sync Status (working dashboard)
 *   - 5 top-level sections + Settings/Docs
 *   - SSE status dot at the top
 */

import { NavLink } from "react-router-dom";

import { useSse } from "../lib/sse.js";

import { StatusDot } from "./ui.js";

interface NavItem {
  to: string;
  label: string;
  badge?: number | null;
  shortcut?: string;
}

export interface SidebarProps {
  badges: {
    repos: number;
    projects: number;
    attention: number;
  };
}

export function Sidebar({ badges }: SidebarProps): React.JSX.Element {
  const { status } = useSse();

  const items: NavItem[] = [
    { to: "/", label: "Sync Status", badge: badges.attention, shortcut: "⌘1" },
    { to: "/repos", label: "Repos", badge: badges.repos, shortcut: "⌘2" },
    {
      to: "/projects",
      label: "Projects",
      badge: badges.projects,
      shortcut: "⌘3"
    },
    { to: "/matrix", label: "Skill Matrix", shortcut: "⌘4" },
    { to: "/settings", label: "Settings", shortcut: "⌘5" }
  ];

  return (
    <aside
      className="w-sidebar-w shrink-0 border-r border-border bg-surface flex flex-col"
      role="navigation"
      aria-label="Primary"
    >
      <div className="px-4 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="text-lg font-semibold tracking-tight">Astack</div>
          <div className="text-[10px] px-1 py-0.5 bg-elevated text-text-muted rounded-xs uppercase">
            v0.1
          </div>
        </div>
        <ServerIndicator status={status} />
      </div>

      <nav className="flex-1 px-2">
        <ul className="flex flex-col">
          {items.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  [
                    "flex items-center justify-between px-2 py-1.5 rounded text-sm transition-colors",
                    isActive
                      ? "bg-elevated text-text-primary"
                      : "text-text-secondary hover:text-text-primary hover:bg-elevated"
                  ].join(" ")
                }
              >
                <span>{item.label}</span>
                <div className="flex items-center gap-2 text-text-muted">
                  {typeof item.badge === "number" && item.badge > 0 ? (
                    <span className="tabular text-xs">{item.badge}</span>
                  ) : null}
                </div>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="p-3 text-xs text-text-muted border-t border-border">
        <div className="flex items-center gap-2">
          <span>Command palette</span>
          <kbd className="px-1.5 py-0.5 text-[10px] rounded-xs border border-border bg-elevated font-mono">
            ⌘K
          </kbd>
        </div>
      </div>
    </aside>
  );
}

function ServerIndicator({ status }: { status: string }): React.JSX.Element {
  const tone =
    status === "online"
      ? "accent"
      : status === "connecting"
        ? "warn"
        : "error";
  const title =
    status === "online"
      ? "Daemon online"
      : status === "connecting"
        ? "Connecting…"
        : "Daemon offline — run: astack server start";
  return (
    <span
      className="flex items-center gap-1"
      title={title}
      aria-label={title}
    >
      <StatusDot tone={tone as "accent" | "warn" | "error"} />
      <span className="text-[10px] uppercase tracking-wide text-text-muted">
        {status}
      </span>
    </span>
  );
}
