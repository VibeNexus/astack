import type * as React from "react";
import type { HTMLAttributes } from "react";

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
