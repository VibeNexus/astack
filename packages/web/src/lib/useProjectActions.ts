/**
 * useProjectActions — unified mutation wrapper for ProjectDetailPage.
 *
 * Every project action (sync, push, subscribe, unsubscribe, link, unlink)
 * follows the same shape:
 *   1. Call the API
 *   2. Toast success or error
 *   3. Reload the page state (unless caller opts out)
 *
 * Before v0.3 each handler copy-pasted this try/catch/toast/reload block,
 * five times. This hook consolidates it and keeps ProjectDetailPage lean
 * as we add new actions (batch subscribe, pin version, custom linked dir).
 *
 * Behavior contract (matching pre-v0.3 handlers byte-for-byte):
 *   - AstackError → toast.error(errMsg, err.message)
 *   - other Error → toast.error(errMsg, String(err))
 *   - On success, toast.ok with okMsg (can be static string or fn(result))
 *   - Auto-reload unless skipReload: true
 *   - Returns the API result on success, undefined on failure (caller can
 *     branch: "if (!result) return")
 */

import { useMemo } from "react";

import { api, AstackError } from "./api.js";
import { useToast } from "./toast.js";

export interface RunActionOptions<T> {
  /** Success message. Can be a function of the result for dynamic text. */
  okMsg?: string | ((result: T) => string);
  /** Error toast title. Always required — makes failures self-documenting. */
  errMsg: string;
  /**
   * Skip the reload() call after success. Set true when the caller manages
   * its own state (e.g. sync shows a result Card instead of relying on page
   * reload to reflect state changes).
   */
  skipReload?: boolean;
}

export interface UseProjectActionsResult {
  sync: () => Promise<ReturnType<typeof api.sync> extends Promise<infer R> ? R | undefined : never>;
  push: () => Promise<ReturnType<typeof api.push> extends Promise<infer R> ? R | undefined : never>;
  unsubscribe: (skillId: number) => Promise<boolean>;
  addLink: (tool: string) => Promise<boolean>;
  removeLink: (tool: string) => Promise<boolean>;
  /**
   * Escape hatch for one-off actions that don't fit the named helpers.
   * Use the named ones by default; only reach for this when adding a new
   * action type in a PR and you don't want to touch this file.
   */
  runAction: <T>(
    fn: () => Promise<T>,
    opts: RunActionOptions<T>
  ) => Promise<T | undefined>;
}

export function useProjectActions(
  projectId: number,
  reload: () => Promise<void>
): UseProjectActionsResult {
  const toast = useToast();

  // Stable reference — reload and toast are captured. React guarantees
  // toast context is stable; reload is the caller's responsibility to
  // memoize (useCallback in the page component).
  return useMemo<UseProjectActionsResult>(() => {
    async function runAction<T>(
      fn: () => Promise<T>,
      opts: RunActionOptions<T>
    ): Promise<T | undefined> {
      try {
        const result = await fn();
        if (opts.okMsg !== undefined) {
          const msg =
            typeof opts.okMsg === "function" ? opts.okMsg(result) : opts.okMsg;
          toast.ok(msg);
        }
        if (!opts.skipReload) {
          await reload();
        }
        return result;
      } catch (err) {
        const detail =
          err instanceof AstackError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        toast.error(opts.errMsg, detail);
        return undefined;
      }
    }

    return {
      sync: () =>
        runAction(() => api.sync(projectId), {
          errMsg: "Sync failed",
          // Sync produces SyncResultCard (PR7) or the existing toast flow
          // in ProjectDetailPage; both manage their own display, so no
          // okMsg here. Reload still runs so the row states update.
        }),
      push: () =>
        runAction(() => api.push(projectId), {
          errMsg: "Push failed"
          // Push result handling (pushed/conflicts/readonly_skipped toast
          // branching) stays in the page — this hook only handles errors
          // + reload.
        }),
      unsubscribe: async (skillId: number) => {
        const res = await runAction(
          () => api.unsubscribe(projectId, skillId),
          { okMsg: "Unsubscribed", errMsg: "Unsubscribe failed" }
        );
        return res !== undefined;
      },
      addLink: async (tool: string) => {
        const res = await runAction(
          () => api.createLinkedDir(projectId, { tool_name: tool }),
          { okMsg: `Linked ${tool}`, errMsg: "Link failed" }
        );
        return res !== undefined;
      },
      removeLink: async (tool: string) => {
        const res = await runAction(
          () => api.deleteLinkedDir(projectId, tool),
          { okMsg: `Removed ${tool}`, errMsg: "Remove failed" }
        );
        return res !== undefined;
      },
      runAction
    };
  }, [projectId, reload, toast]);
}
