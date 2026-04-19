import type * as React from "react";
/**
 * Tiny primitive components used across pages.
 *
 * Deliberately light-weight — we don't pull in shadcn/ui for v1 because
 * every dependency ships CSS we'd have to override back to the
 * design tokens. When the component set grows, swap in shadcn.
 */

import type { ButtonHTMLAttributes, HTMLAttributes, PropsWithChildren } from "react";

// ---------- Button ----------

type ButtonVariant = "primary" | "outline" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
}

export function Button({
  variant = "outline",
  size = "md",
  className = "",
  children,
  ...rest
}: ButtonProps): React.JSX.Element {
  const base =
    "inline-flex items-center gap-1.5 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium focus-visible:ring-2 focus-visible:ring-accent";
  const padding = size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm";
  const variantCss =
    variant === "primary"
      ? "bg-accent text-base hover:bg-accent-hover"
      : variant === "outline"
        ? "border border-border bg-transparent text-text-primary hover:bg-surface"
        : "bg-transparent text-text-secondary hover:text-text-primary hover:bg-surface";
  return (
    <button className={`${base} ${padding} ${variantCss} ${className}`} {...rest}>
      {children}
    </button>
  );
}

// ---------- Badge ----------

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
      ? "text-accent bg-accent-muted/40 border-accent/30"
      : tone === "warn"
        ? "text-warn bg-warn/10 border-warn/30"
        : tone === "error"
          ? "text-error bg-error/10 border-error/30"
          : "text-text-secondary bg-surface border-border";
  return (
    <span
      className={`inline-flex items-center text-xs px-1.5 py-0.5 rounded-xs border tabular ${toneCss} ${className}`}
      {...rest}
    >
      {children}
    </span>
  );
}

// ---------- StatusDot ----------

export function StatusDot({
  tone
}: {
  tone: "accent" | "warn" | "error" | "muted";
}): React.JSX.Element {
  const color =
    tone === "accent"
      ? "bg-accent"
      : tone === "warn"
        ? "bg-warn"
        : tone === "error"
          ? "bg-error"
          : "bg-text-muted";
  return <span className={`status-dot ${color}`} />;
}

// ---------- Card ----------

export function Card({
  className = "",
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={`bg-surface border border-border rounded p-4 ${className}`}
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
    <div className="flex flex-col items-start gap-3 p-8 border border-dashed border-border rounded">
      <div>
        <div className="text-lg font-medium">{title}</div>
        {hint ? (
          <div className="text-sm text-text-secondary mt-1">{hint}</div>
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
      className={`animate-pulse bg-elevated rounded ${className}`}
      aria-hidden="true"
    />
  );
}

// ---------- Kbd ----------

export function Kbd({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <kbd className="inline-flex items-center px-1.5 py-0.5 text-[11px] rounded-xs border border-border bg-elevated text-text-secondary font-mono">
      {children}
    </kbd>
  );
}
