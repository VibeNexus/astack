import type * as React from "react";
import type { ButtonHTMLAttributes } from "react";

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
