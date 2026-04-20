import type * as React from "react";
/**
 * Primitive components for the Graphite UI design system.
 *
 * Design principles:
 *   - Typography does the work, not color
 *   - Surfaces are translucent overlays on canvas, not opaque dark greys
 *   - Rounded corners are small (6px); we're precise, not bubbly
 *   - No badges by default — status goes inline with text + symbol
 *   - Buttons have three weights: primary (rare), default, ghost
 */

import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  PropsWithChildren
} from "react";

// ---------- Button ----------

// "outline" is a legacy alias for "default" — older pages used the old name.
// Both render the same subtle surface+border button.
type ButtonVariant = "primary" | "default" | "outline" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
}

export function Button({
  variant = "default",
  size = "md",
  className = "",
  children,
  ...rest
}: ButtonProps): React.JSX.Element {
  const base =
    "inline-flex items-center justify-center gap-1.5 select-none " +
    "font-medium rounded-md transition-colors duration-fast ease-out " +
    "disabled:opacity-40 disabled:cursor-not-allowed " +
    "focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-0";
  const padding =
    size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm";
  const variantCss =
    variant === "primary"
      ? // Solid accent; use sparingly (one per screen, ideally).
        "bg-accent text-accent-fg hover:bg-accent-hover"
      : variant === "danger"
        ? "bg-transparent text-error hover:bg-error/10 border border-transparent hover:border-error/20"
        : variant === "ghost"
          ? "bg-transparent text-fg-secondary hover:text-fg-primary hover:bg-surface-2"
          : // default + outline: subtle surface + border
            "bg-surface-1 text-fg-primary border border-line-subtle hover:bg-surface-2 hover:border-line";
  return (
    <button
      className={`${base} ${padding} ${variantCss} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------- StatusDot ----------

export type StatusTone = "accent" | "warn" | "error" | "muted" | "hollow";

export function StatusDot({
  tone,
  className = ""
}: {
  tone: StatusTone;
  className?: string;
}): React.JSX.Element {
  if (tone === "hollow") {
    // Hollow circle for "read-only" / non-filled states. Same footprint
    // as the filled dot so alignment is stable.
    return (
      <span
        aria-hidden
        className={`inline-block w-1.5 h-1.5 rounded-full border border-fg-tertiary ${className}`}
      />
    );
  }
  const color =
    tone === "accent"
      ? "bg-accent"
      : tone === "warn"
        ? "bg-warn"
        : tone === "error"
          ? "bg-error"
          : "bg-fg-tertiary";
  return <span aria-hidden className={`status-dot ${color} ${className}`} />;
}

// ---------- InlineTag ----------

/**
 * Tiny inline label used next to titles. Way less visual weight than a
 * traditional pill badge. Reads like metadata.
 *
 * Example:  status-dot + "read-only"  instead of  [read-only] badge
 */
export function InlineTag({
  children,
  tone = "muted",
  className = ""
}: PropsWithChildren<{
  tone?: StatusTone;
  className?: string;
}>): React.JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs text-fg-tertiary ${className}`}
    >
      <StatusDot tone={tone} />
      {children}
    </span>
  );
}

// ---------- Badge (legacy; avoid on new surfaces) ----------

/**
 * Legacy badge. Most new UI should prefer `<InlineTag>` — a traditional
 * pill badge has too much visual weight for how often we use it.
 * Kept so existing pages render during the redesign.
 */
export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: "neutral" | "accent" | "warn" | "error";
}

export function Badge({
  tone = "neutral",
  className = "",
  children,
  ...rest
}: BadgeProps): React.JSX.Element {
  const toneCss =
    tone === "accent"
      ? "text-accent bg-accent/10 border-accent/20"
      : tone === "warn"
        ? "text-warn bg-warn/10 border-warn/20"
        : tone === "error"
          ? "text-error bg-error/10 border-error/20"
          : "text-fg-secondary bg-surface-1 border-line-subtle";
  return (
    <span
      className={
        "inline-flex items-center text-xs h-5 px-1.5 rounded-xs border tabular " +
        toneCss +
        " " +
        className
      }
      {...rest}
    >
      {children}
    </span>
  );
}

// ---------- Card ----------

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Interactive cards get a hover state and a pointer cursor. */
  interactive?: boolean;
}

export function Card({
  className = "",
  interactive = false,
  children,
  ...rest
}: CardProps): React.JSX.Element {
  const hover = interactive
    ? "hover:bg-surface-2 hover:border-line transition-colors duration-fast"
    : "";
  return (
    <div
      className={`bg-surface-1 border border-line-subtle rounded-lg ${hover} ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

// ---------- EmptyState ----------

export function EmptyState({
  title,
  hint,
  children
}: PropsWithChildren<{ title: string; hint?: string }>): React.JSX.Element {
  return (
    <div className="flex flex-col items-start gap-4 py-12 px-8 border border-dashed border-line-subtle rounded-lg">
      <div>
        <div className="text-lg font-semibold text-fg-primary">{title}</div>
        {hint ? (
          <div className="text-sm text-fg-secondary mt-1 max-w-md">
            {hint}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

// ---------- Skeleton ----------

export function Skeleton({
  className = ""
}: {
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={`animate-pulse bg-surface-2 rounded ${className}`}
      aria-hidden="true"
    />
  );
}

// ---------- Kbd ----------

export function Kbd({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <kbd
      className="inline-flex items-center h-5 px-1.5 text-[11px] rounded-xs
        border border-line-subtle bg-surface-1 text-fg-secondary font-mono"
    >
      {children}
    </kbd>
  );
}

// ---------- IconButton ----------

/**
 * Square icon button used for ⋯ menus and similar. Smaller than a full
 * Button, no label.
 */
export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
}

export function IconButton({
  label,
  className = "",
  children,
  ...rest
}: IconButtonProps): React.JSX.Element {
  return (
    <button
      aria-label={label}
      title={label}
      className={
        "inline-flex items-center justify-center w-7 h-7 rounded-md " +
        "text-fg-secondary hover:text-fg-primary hover:bg-surface-2 " +
        "transition-colors duration-fast " +
        "focus-visible:ring-2 focus-visible:ring-accent/60 " +
        className
      }
      {...rest}
    >
      {children}
    </button>
  );
}
