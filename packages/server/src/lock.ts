/**
 * Per-repository mutex manager.
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  LockManager — per-repo serialization                       │
 * │                                                             │
 * │  Map<repoId, Mutex>                                         │
 * │                                                             │
 * │  request A (repo 1) ──► [acquire]───► held ─► release       │
 * │  request B (repo 1) ──► [wait ≤30s] ─► acquire              │
 * │  request C (repo 2) ──► [acquire parallel]  (different key) │
 * │                                                             │
 * │  Timeout ⇒ throw AstackError(REPO_BUSY)                     │
 * └─────────────────────────────────────────────────────────────┘
 *
 * See design.md § Eng Review decision 5.
 *
 * Why per-repo (not per-skill):
 *   Git operations commit/push at the repo level. A skill-level lock would
 *   leave room for interleaved commits on the same repo which is racy.
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

export class LockManager {
  private readonly timeoutMs: number;
  private readonly locks = new Map<number, MutexState>();

  constructor(opts: LockManagerOptions) {
    this.timeoutMs = opts.timeoutMs;
  }

  /**
   * Acquire the mutex for `repoId`. Returns a release function the caller
   * MUST call in a `finally` block.
   *
   * Throws AstackError(REPO_BUSY) if timeout expires while waiting.
   */
  async acquire(repoId: number): Promise<() => void> {
    const state = this.getOrCreate(repoId);

    if (!state.held) {
      state.held = true;
      return () => this.release(repoId);
    }

    // Contended — wait in queue, bounded by timeoutMs.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove from queue on timeout.
        const idx = state.queue.findIndex((w) => w.timer === timer);
        if (idx >= 0) state.queue.splice(idx, 1);
        reject(
          new AstackError(ErrorCode.REPO_BUSY, "repo is busy", {
            repo_id: repoId,
            waited_ms: this.timeoutMs
          })
        );
      }, this.timeoutMs);

      state.queue.push({ resolve, reject, timer });
    });

    state.held = true;
    return () => this.release(repoId);
  }

  /** Runs `fn` while holding the lock; releases in `finally`. */
  async withLock<T>(repoId: number, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(repoId);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private release(repoId: number): void {
    const state = this.locks.get(repoId);
    if (!state) return;

    const next = state.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    } else {
      state.held = false;
    }
  }

  private getOrCreate(repoId: number): MutexState {
    let state = this.locks.get(repoId);
    if (!state) {
      state = { held: false, queue: [] };
      this.locks.set(repoId, state);
    }
    return state;
  }

  /** For tests / diagnostics. */
  isHeld(repoId: number): boolean {
    return this.locks.get(repoId)?.held ?? false;
  }

  /** For tests / diagnostics. */
  queueSize(repoId: number): number {
    return this.locks.get(repoId)?.queue.length ?? 0;
  }
}
