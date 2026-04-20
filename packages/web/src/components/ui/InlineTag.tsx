import type * as React from "react";
import type { PropsWithChildren } from "react";

import { StatusDot, type StatusTone } from "./StatusDot.js";

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
