import type * as React from "react";
import type { PropsWithChildren } from "react";

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
