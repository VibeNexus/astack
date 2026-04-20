import type * as React from "react";
import type { ButtonHTMLAttributes } from "react";

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
