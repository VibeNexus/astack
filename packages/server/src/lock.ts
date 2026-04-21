/**
 * Per-key mutex manager.
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  LockManager — per-key serialization                        │
 * │                                                             │
 * │  Map<key, Mutex>      key: number | string                  │
 * │                                                             │
 * │  request A (key 1)   ──► [acquire]───► held ─► release      │
 * │  request B (key 1)   ──► [wait ≤30s] ─► acquire             │
 * │  request C (key 2)   ──► [acquire parallel]  (different key)│
 * │                                                             │
 * │  Timeout ⇒ throw AstackError(REPO_BUSY)                     │
 * └─────────────────────────────────────────────────────────────┘
 *
 * See design.md § Eng Review decision 5.
 *
 * Why per-repo (not per-skill):
 *   Git operations commit/push at the repo level. A skill-level lock would
 *   leave room for interleaved commits on the same repo which is racy.
 *
 * v0.5: extended to accept string keys so unrelated subsystems (project
 * bootstrap, see v0.5 spec §A9) can coexist without colliding with
 * numeric repoIds. Keys are converted to strings internally; callers
 * still pass numbers for repos and strings like
 * `project-bootstrap-<projectId>` for project-scoped flows.
 */

import { AstackError, ErrorCode } from "@astack/shared";

/** Internal waiting queue entry. */
interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout;
}

/** Per-key mutex state. */
interface MutexState {
  held: boolean;
  queue: Waiter[];
}

export interface LockManagerOptions {
  /** Max wait time before REPO_BUSY, in ms. */
  timeoutMs: number;
}

/** Anything we accept as a lock key — kept narrow on purpose. */
export type LockKey = number | string;

/** Internal canonical-string form (so number 1 and string "1" never collide). */
function canonicalize(key: LockKey): string {
  return typeof key === "number" ? `n:${key}` : `s:${key}`;
}

export class LockManager {
  private readonly timeoutMs: number;
  private readonly locks = new Map<string, MutexState>();

  constructor(opts: LockManagerOptions) {
    this.timeoutMs = opts.timeoutMs;
  }

  /**
   * Acquire the mutex for `key`. Returns a release function the caller
   * MUST call in a `finally` block.
   *
   * Throws AstackError(REPO_BUSY) if timeout expires while waiting.
   */
  async acquire(key: LockKey): Promise<() => void> {
    const canonical = canonicalize(key);
    const state = this.getOrCreate(canonical);

    if (!state.held) {
      state.held = true;
      return () => this.release(canonical);
    }

    // Contended — wait in queue, bounded by timeoutMs.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove from queue on timeout.
        const idx = state.queue.findIndex((w) => w.timer === timer);
        if (idx >= 0) state.queue.splice(idx, 1);
        // Preserve `repo_id` in details when key is numeric (back-compat
        // with existing CLI/Web error rendering); add `key` field for the
        // v0.5 string-keyed bootstrap flow.
        const details: Record<string, unknown> =
          typeof key === "number"
            ? { repo_id: key, waited_ms: this.timeoutMs }
            : { key, waited_ms: this.timeoutMs };
        reject(
          new AstackError(
            ErrorCode.REPO_BUSY,
            "lock acquisition timed out",
            details
          )
        );
      }, this.timeoutMs);

      state.queue.push({ resolve, reject, timer });
    });

    state.held = true;
    return () => this.release(canonical);
  }

  /** Runs `fn` while holding the lock; releases in `finally`. */
  async withLock<T>(key: LockKey, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private release(canonical: string): void {
    const state = this.locks.get(canonical);
    if (!state) return;

    const next = state.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    } else {
      state.held = false;
    }
  }

  private getOrCreate(canonical: string): MutexState {
    let state = this.locks.get(canonical);
    if (!state) {
      state = { held: false, queue: [] };
      this.locks.set(canonical, state);
    }
    return state;
  }

  /** For tests / diagnostics. */
  isHeld(key: LockKey): boolean {
    return this.locks.get(canonicalize(key))?.held ?? false;
  }

  /** For tests / diagnostics. */
  queueSize(key: LockKey): number {
    return this.locks.get(canonicalize(key))?.queue.length ?? 0;
  }
}

/**
 * Canonical lock key for project-bootstrap (v0.5 §A9). Used by
 * ProjectBootstrapService and SyncService.pullBatch to serialise.
 */
export function projectBootstrapLockKey(projectId: number): string {
  return `project-bootstrap-${projectId}`;
}
