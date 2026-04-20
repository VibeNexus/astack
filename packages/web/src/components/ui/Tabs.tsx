import type * as React from "react";
import { useCallback, useEffect, useId, useRef } from "react";

/**
 * Tabs primitive — accessible, keyboard-driven, visually aligned with
 * the Sidebar's active-rail pattern.
 *
 * Why roll our own instead of Radix / HeadlessUI:
 *   - Graphite UI is zero-dep by design
 *   - We only need horizontal tabs, top-aligned; full lib is overkill
 *   - Full control over focus/aria to match WAI-ARIA APG reliably
 *
 * Accessibility contract (WAI-ARIA APG Tabs pattern):
 *   - Container has role="tablist" aria-orientation="horizontal"
 *   - Each tab is role="tab" with aria-selected, aria-controls, id
 *   - Panels are NOT owned by this component — callers render them with
 *     role="tabpanel" aria-labelledby matching the tab's id.
 *   - Roving tabindex: active tab is tabindex=0, others are tabindex=-1
 *   - Keys: ← / → cycle siblings, Home / End jump to first / last,
 *     Enter / Space activate (actually selection follows focus, which is
 *     APG "automatic activation" — suitable here because panel switching
 *     is instant and stateless)
 *
 * Controlled component: `activeId` + `onChange` live in the parent so
 * the v0.3 ProjectDetailPage can sync with useSearchParams('?tab=...').
 */

export interface TabItem {
  /** Stable identifier; also used in URL params. */
  id: string;
  /** Human label rendered in the tab. */
  label: string;
  /**
   * Optional badge (count) shown right of the label. Zero / undefined
   * hides it — prevents "Subscriptions 0" visual noise.
   */
  badge?: number | null;
  /** Disables the tab; still rendered for layout stability. */
  disabled?: boolean;
}

export interface TabsProps {
  tabs: readonly TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  /** Accessible name for the tablist. */
  "aria-label": string;
  /**
   * Prefix for generated DOM ids (tabs + panels). Defaults to a React
   * useId() value, but callers can pass one for stable ids in tests.
   */
  idPrefix?: string;
  className?: string;
}

export function Tabs({
  tabs,
  activeId,
  onChange,
  "aria-label": ariaLabel,
  idPrefix,
  className = ""
}: TabsProps): React.JSX.Element {
  const fallbackId = useId();
  const prefix = idPrefix ?? fallbackId;
  const listRef = useRef<HTMLDivElement | null>(null);

  // Given the current active tab, move focus+selection to the next/prev/
  // first/last enabled sibling. Skips disabled tabs so keyboard users
  // don't land on a useless target.
  const move = useCallback(
    (direction: "prev" | "next" | "first" | "last") => {
      const enabled = tabs.filter((t) => !t.disabled);
      if (enabled.length === 0) return;
      const currentIdx = enabled.findIndex((t) => t.id === activeId);
      let nextIdx: number;
      if (direction === "first") nextIdx = 0;
      else if (direction === "last") nextIdx = enabled.length - 1;
      else if (direction === "next")
        nextIdx = (currentIdx + 1) % enabled.length;
      else
        nextIdx =
          currentIdx <= 0 ? enabled.length - 1 : currentIdx - 1;
      const nextId = enabled[nextIdx]!.id;
      onChange(nextId);
      // Move focus as well so users see where they landed.
      const el = listRef.current?.querySelector<HTMLButtonElement>(
        `[data-tab-id="${nextId}"]`
      );
      el?.focus();
    },
    [tabs, activeId, onChange]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      switch (e.key) {
        case "ArrowRight":
          e.preventDefault();
          move("next");
          break;
        case "ArrowLeft":
          e.preventDefault();
          move("prev");
          break;
        case "Home":
          e.preventDefault();
          move("first");
          break;
        case "End":
          e.preventDefault();
          move("last");
          break;
        default:
          break;
      }
    },
    [move]
  );

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className={
        "relative flex items-center gap-1 border-b border-line-subtle " +
        className
      }
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        const tabId = `${prefix}-tab-${tab.id}`;
        const panelId = `${prefix}-panel-${tab.id}`;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={tabId}
            data-tab-id={tab.id}
            aria-selected={isActive}
            aria-controls={panelId}
            aria-disabled={tab.disabled || undefined}
            disabled={tab.disabled}
            tabIndex={isActive ? 0 : -1}
            onClick={() => {
              if (!tab.disabled) onChange(tab.id);
            }}
            className={[
              "group relative h-9 px-3 inline-flex items-center gap-1.5",
              "text-sm transition-colors duration-fast",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
              tab.disabled
                ? "text-fg-quaternary cursor-not-allowed"
                : isActive
                  ? "text-fg-primary"
                  : "text-fg-secondary hover:text-fg-primary"
            ].join(" ")}
          >
            <span>{tab.label}</span>
            {typeof tab.badge === "number" && tab.badge > 0 ? (
              <span className="tabular text-xs text-fg-tertiary group-hover:text-fg-secondary">
                {tab.badge}
              </span>
            ) : null}
            {isActive ? (
              <span
                aria-hidden
                className="absolute left-0 right-0 -bottom-px h-[2px] bg-accent rounded-full"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Render a tab panel that pairs with the Tabs above. Parent decides
 * whether to mount-and-hide or unmount when inactive; this component
 * just attaches the correct aria-labelledby / id / role so screen
 * readers wire it up to the matching tab.
 *
 * Use `hidden` when you want React to keep panel state across switches
 * (e.g. scroll position, unsaved form inputs). Default: unmounts inactive.
 */
export interface TabPanelProps {
  tabId: string;
  activeId: string;
  /** Must match the Tabs `idPrefix` for aria wiring. */
  idPrefix: string;
  /** Keep inactive panels in the DOM with `hidden` instead of unmounting. */
  keepMounted?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function TabPanel({
  tabId,
  activeId,
  idPrefix,
  keepMounted = false,
  children,
  className = ""
}: TabPanelProps): React.JSX.Element | null {
  const isActive = tabId === activeId;
  const panelId = `${idPrefix}-panel-${tabId}`;
  const tabLabelId = `${idPrefix}-tab-${tabId}`;
  if (!isActive && !keepMounted) return null;
  return (
    <div
      role="tabpanel"
      id={panelId}
      aria-labelledby={tabLabelId}
      hidden={!isActive}
      tabIndex={0}
      className={className}
    >
      {children}
    </div>
  );
}

// Silence unused-import warning if someone imports just one half. Keeps
// the module tree-shakeable for the common "Tabs but no TabPanel" case
// (callers often render their panels with custom wrappers).
void useEffect;
