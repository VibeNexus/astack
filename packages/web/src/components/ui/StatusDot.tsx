import type * as React from "react";

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
