import type * as React from "react";
import type { HTMLAttributes } from "react";

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
