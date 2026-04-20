import type * as React from "react";
/**
 * Left sidebar navigation (232px fixed).
 *
 * Graphite UI v0.3:
 *   - Active item uses a 2px accent rail on the left, not a background fill
 *   - Logo + version + SSE status all fit on one tight row
 *   - Badges: right-aligned tabular numbers in fg-tertiary (no pills)
 *   - ⌘K hint lives in a footer with hairline above it
 */

import { NavLink } from "react-router-dom";

import { useSse, type SseStatus } from "../lib/sse.js";

import { StatusDot } from "./ui/index.js";

interface NavItem {
  to: string;
  label: string;
  badge?: number | null;
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
    { to: "/", label: "Sync Status", badge: badges.attention },
    { to: "/repos", label: "Repos", badge: badges.repos },
    { to: "/projects", label: "Projects", badge: badges.projects },
    { to: "/matrix", label: "Matrix" },
    { to: "/settings", label: "Settings" }
  ];

  return (
    <aside
      className="w-sidebar-w shrink-0 flex flex-col border-r border-line-subtle bg-canvas"
      role="navigation"
      aria-label="Primary"
    >
      {/* Brand row */}
      <div className="h-14 px-5 flex items-center justify-between">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[15px] font-semibold tracking-tight text-fg-primary">
            Astack
          </span>
          <span className="text-[11px] font-mono text-fg-quaternary">
            v0.2
          </span>
        </div>
        <ServerIndicator status={status} />
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3">
        <ul className="flex flex-col gap-px">
          {items.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  [
                    "group relative flex items-center justify-between",
                    "h-8 pl-3 pr-2 rounded-md text-sm transition-colors duration-fast",
                    isActive
                      ? "text-fg-primary"
                      : "text-fg-secondary hover:text-fg-primary hover:bg-surface-1"
                  ].join(" ")
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive ? (
                      <span
                        aria-hidden
                        className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent"
                      />
                    ) : null}
                    <span className="truncate">{item.label}</span>
                    {typeof item.badge === "number" && item.badge > 0 ? (
                      <span className="tabular text-xs text-fg-tertiary group-hover:text-fg-secondary">
                        {item.badge}
                      </span>
                    ) : null}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      {/* Footer */}
      <div className="px-5 py-3 hairline">
        <div className="flex items-center gap-2 text-xs text-fg-tertiary">
          <span>Command palette</span>
          <kbd className="inline-flex items-center h-4 px-1 text-[10px] rounded-xs border border-line-subtle bg-surface-1 font-mono text-fg-secondary">
            ⌘K
          </kbd>
        </div>
      </div>
    </aside>
  );
}

function ServerIndicator({ status }: { status: SseStatus }): React.JSX.Element {
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
        ? "Connecting to daemon"
        : "Daemon offline — run: astack server start";
  return (
    <span
      className="flex items-center gap-1.5"
      title={title}
      aria-label={title}
    >
      <StatusDot tone={tone} />
    </span>
  );
}
