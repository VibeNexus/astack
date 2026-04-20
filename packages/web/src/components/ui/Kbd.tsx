import type * as React from "react";
import type { PropsWithChildren } from "react";

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
