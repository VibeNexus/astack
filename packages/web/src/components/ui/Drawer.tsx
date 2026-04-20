import type * as React from "react";
import {
  useCallback,
  useEffect,
  useRef,
  type PropsWithChildren
} from "react";

/**
 * Drawer primitive — right-side slide-out panel with focus trap.
 *
 * v0.3 use cases:
 *   - BrowseSkillsDrawer (subscribe to skills from any registered repo)
 *   - Future: sync log detail preview, resolve-page preview
 *
 * Zero-dep focus trap implemented inline (~30 lines). Focus cycles
 * within the drawer while open, returns to the opener on close. Esc
 * and outside-click both close. Respects prefers-reduced-motion.
 *
 * Accessibility contract (WAI-ARIA APG Dialog pattern):
 *   - role="dialog" aria-modal="true"
 *   - Drawer receives focus on open; aria-label or aria-labelledby must
 *     be provided via props
 *   - Focus trap prevents Tab-ing out of the drawer
 *   - Esc fires onClose
 *   - Background `inert` would be ideal but browser support is shaky;
 *     we rely on focus trap + the overlay catching pointer events instead
 */

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name. Required — this is a dialog. */
  "aria-label": string;
  /** Width in px for the desktop drawer. Mobile always full-width. */
  width?: number;
  /**
   * When true, render children even while closed (kept hidden). Useful
   * when the drawer has expensive init or preserves scroll state across
   * open/close cycles. Default: unmount when closed.
   */
  keepMounted?: boolean;
  children?: React.ReactNode;
}

/** Tab-able elements inside the drawer, per APG Dialog focus-trap rules. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])'
].join(",");

export function Drawer({
  open,
  onClose,
  "aria-label": ariaLabel,
  width = 480,
  keepMounted = false,
  children
}: DrawerProps): React.JSX.Element | null {
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // ---- Open-side effects: remember opener, focus first child, trap Tab ----
  useEffect(() => {
    if (!open) return undefined;
    // Remember the element that had focus when the drawer opened so we
    // can return it on close (APG requirement).
    returnFocusRef.current = document.activeElement as HTMLElement | null;

    // Move focus into the drawer on the next microtask — waiting for
    // React to commit the DOM. First focusable child; fall back to the
    // drawer container itself (it has tabIndex=-1).
    const raf = requestAnimationFrame(() => {
      const first =
        drawerRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? drawerRef.current)?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // ---- Close-side effect: return focus to opener ----
  useEffect(() => {
    if (open) return undefined;
    // On transition from open → closed, hand focus back. Runs on the
    // `open=false` render, which is after the close event fired.
    const node = returnFocusRef.current;
    if (node && typeof node.focus === "function") {
      node.focus();
    }
    returnFocusRef.current = null;
    return undefined;
  }, [open]);

  // ---- Key handler: Esc closes, Tab cycles within drawer ----
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const container = drawerRef.current;
      if (!container) return;
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter(
        // Skip hidden elements. `offsetParent === null` is a cheap visibility
        // check that works for display:none; doesn't catch visibility:hidden
        // but is good enough for the inputs/buttons we render here.
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (focusables.length === 0) return;

      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey) {
        // Shift+Tab on first → wrap to last
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab on last → wrap to first
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onClose]
  );

  if (!open && !keepMounted) return null;

  return (
    <div
      // Backdrop: clicking it closes the drawer. Pointer events disabled
      // when closed+keepMounted so underlying page is interactive again.
      className={[
        "fixed inset-0 z-40 transition-opacity duration-fast",
        open
          ? "bg-base/60 opacity-100 pointer-events-auto"
          : "opacity-0 pointer-events-none"
      ].join(" ")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-hidden={!open}
    >
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{ width: `min(${width}px, 100vw)` }}
        className={[
          "absolute right-0 top-0 h-full",
          "bg-elevated border-l border-border",
          "shadow-2xl shadow-black/40",
          "flex flex-col",
          "transition-transform duration-fast ease-out motion-reduce:transition-none",
          open ? "translate-x-0" : "translate-x-full"
        ].join(" ")}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Convenience header for a Drawer. Titles the dialog + provides a close
 * button. The close button gets aria-label="Close" and wires through
 * to the Drawer's onClose via prop.
 *
 * Purely presentational — use it if you want; the Drawer above doesn't
 * require it. If you don't use it, make sure your header still provides
 * a labeled close affordance.
 */
export function DrawerHeader({
  title,
  onClose,
  children
}: PropsWithChildren<{ title: string; onClose: () => void }>): React.JSX.Element {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-line-subtle px-5 h-14 shrink-0">
      <h2 className="text-base font-semibold text-fg-primary truncate">
        {title}
      </h2>
      <div className="flex items-center gap-2">
        {children}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="inline-flex items-center justify-center w-8 h-8 rounded-md text-fg-secondary hover:text-fg-primary hover:bg-surface-2 transition-colors duration-fast focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            aria-hidden
          >
            <path
              d="M3 3L11 11M11 3L3 11"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </header>
  );
}
