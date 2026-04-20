import type * as React from "react";

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
