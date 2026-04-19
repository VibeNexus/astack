import type * as React from "react";
/**
 * Minimal toast system (no external library).
 *
 * Toasts auto-dismiss after 3s. Errors stay until user clicks.
 * Following design review decision 4 copy style.
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { PropsWithChildren } from "react";

export type ToastKind = "ok" | "warn" | "error";

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
}

interface ToastContextValue {
  push: (toast: Omit<Toast, "id">) => void;
  ok: (title: string, detail?: string) => void;
  warn: (title: string, detail?: string) => void;
  error: (title: string, detail?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, ...t }]);
  }, []);

  const value: ToastContextValue = {
    push,
    ok: (title, detail) => push({ kind: "ok", title, detail }),
    warn: (title, detail) => push({ kind: "warn", title, detail }),
    error: (title, detail) => push({ kind: "error", title, detail })
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="fixed bottom-6 right-6 flex flex-col gap-2 z-50"
        role="status"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <ToastItem
            key={t.id}
            toast={t}
            onDismiss={() =>
              setToasts((prev) => prev.filter((x) => x.id !== t.id))
            }
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({
  toast,
  onDismiss
}: {
  toast: Toast;
  onDismiss: () => void;
}): React.JSX.Element {
  // Auto-dismiss success + warn after 3s; errors stay.
  useEffect(() => {
    if (toast.kind === "error") return;
    const t = setTimeout(onDismiss, 3000);
    return () => clearTimeout(t);
  }, [toast.kind, onDismiss]);

  const color =
    toast.kind === "ok"
      ? "border-accent text-accent"
      : toast.kind === "warn"
        ? "border-warn text-warn"
        : "border-error text-error";

  return (
    <div
      className={`min-w-[260px] max-w-[420px] bg-elevated border ${color} rounded px-3 py-2 shadow`}
      onClick={onDismiss}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onDismiss();
      }}
    >
      <div className="text-sm font-medium">{toast.title}</div>
      {toast.detail ? (
        <div className="text-xs text-text-secondary mt-1 break-all">
          {toast.detail}
        </div>
      ) : null}
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
