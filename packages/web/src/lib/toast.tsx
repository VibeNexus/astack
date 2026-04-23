import type * as React from "react";
/**
 * Minimal toast system (no external library).
 *
 * Auto-dismiss timings:
 *   - ok / warn: 3s
 *   - error: 10s (longer so users can read stderr fragments)
 *
 * Every toast also has an explicit "×" close button and is click-to-dismiss
 * on the body. Pre-v0.8 the error toast only supported click-to-dismiss with
 * no auto-dismiss and no close affordance, which meant:
 *   (a) users who selected the `detail` text (e.g. to copy a git stderr
 *       fragment) never triggered a click, so the toast got stuck;
 *   (b) errors stacked up indefinitely in the bottom-right corner.
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
  // Auto-dismiss: ok/warn after 3s, errors after 10s. Errors linger longer
  // so users can read stderr fragments, but we never leave a toast on
  // screen forever — they used to stack up indefinitely when a batch
  // action produced many failures.
  useEffect(() => {
    const delay = toast.kind === "error" ? 10_000 : 3_000;
    const t = setTimeout(onDismiss, delay);
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
      className={`relative min-w-[260px] max-w-[420px] bg-elevated border ${color} rounded pl-3 pr-8 py-2 shadow`}
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
      <button
        type="button"
        aria-label="Dismiss"
        className="absolute top-1 right-1 w-6 h-6 flex items-center justify-center text-text-secondary hover:text-text-primary text-base leading-none"
        onClick={(e) => {
          // Stop propagation so the body's onClick doesn't double-fire;
          // not strictly necessary since both call onDismiss, but keeps
          // the event model clean.
          e.stopPropagation();
          onDismiss();
        }}
      >
      </button>
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
