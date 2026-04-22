/**
 * Git wrapper thin layer.
 *
 * Wraps `simple-git` with Astack's error handling contract:
 * any git failure becomes an AstackError(REPO_GIT_FAILED) with
 * the underlying stderr in `details.git_stderr`.
 *
 * Keeps git specifics out of RepoService so the service can focus
 * on business logic (lock, scan, emit events) instead of argv plumbing.
 */

import fs from "node:fs";
import path from "node:path";

import { AstackError, ErrorCode } from "@astack/shared";
import { simpleGit, type SimpleGit } from "simple-git";

export interface GitCloneOptions {
  /** Use --depth 1 to avoid pulling full history. */
  shallow: boolean;
}

export interface GitRepoInfo {
  /** Current HEAD commit hash (full 40-char). */
  head: string;
  /** ISO time of HEAD commit. */
  head_time: string;
}

/**
 * Clone a remote git URL into `localPath`. Creates parent dir if needed.
 * Throws REPO_GIT_FAILED on any git error.
 */
export async function gitClone(
  gitUrl: string,
  localPath: string,
  opts: GitCloneOptions
): Promise<void> {
  fs.mkdirSync(path.dirname(localPath), { recursive: true });

  const git = simpleGit();
  const args: string[] = [];
  if (opts.shallow) args.push("--depth", "1");

  try {
    await git.clone(gitUrl, localPath, args);
  } catch (err) {
    throw wrapGitError(err, "git clone failed", { git_url: gitUrl });
  }
}

/**
 * Fetch + fast-forward the current branch.
 *
 * Uses `git pull --ff-only` to avoid producing merge commits in the
 * upstream mirror (merges should happen at the remote).
 */
export async function gitPull(localPath: string): Promise<void> {
  try {
    const git = simpleGit(localPath);
    await git.pull(["--ff-only"]);
  } catch (err) {
    throw wrapGitError(err, "git pull failed", { local_path: localPath });
  }
}

/** Stage everything, commit, and push. Throws on any git failure. */
export async function gitCommitAndPush(
  localPath: string,
  message: string,
  author: { name: string; email: string }
): Promise<string> {
  try {
    const git = simpleGit(localPath);
    await git.add(".");
    const commit = await git.commit(message, [], {
      "--author": `${author.name} <${author.email}>`
    });
    await git.push();
    return commit.commit;
  } catch (err) {
    throw wrapGitError(err, "git commit/push failed", {
      local_path: localPath,
      message
    });
  }
}

/**
 * Get current HEAD commit hash + commit time for a local repo.
 */
export async function gitGetHead(localPath: string): Promise<GitRepoInfo> {
  try {
    const git = simpleGit(localPath);
    const hash = (await git.revparse(["HEAD"])).trim();
    const log = await git.log({ maxCount: 1 });
    const time = log.latest?.date ?? new Date().toISOString();
    return { head: hash, head_time: toIso(time) };
  } catch (err) {
    throw wrapGitError(err, "git read HEAD failed", { local_path: localPath });
  }
}

/**
 * Check whether remote has moved past local HEAD (i.e. pull would update).
 * Returns the remote HEAD hash regardless.
 */
export async function gitRemoteHead(localPath: string): Promise<string> {
  try {
    const git = simpleGit(localPath);
    // `git ls-remote origin HEAD` returns: `<hash>\tHEAD`
    // Note: `--heads` would filter to refs/heads/* and exclude HEAD ref.
    const result = await git.listRemote(["origin", "HEAD"]);
    const firstLine = result.trim().split("\n")[0] ?? "";
    const hash = firstLine.split(/\s+/)[0] ?? "";
    if (!/^[0-9a-f]{40}$/i.test(hash)) {
      throw new Error(`unexpected ls-remote output: ${result}`);
    }
    return hash;
  } catch (err) {
    throw wrapGitError(err, "git ls-remote failed", { local_path: localPath });
  }
}

/** True if the local repo has no uncommitted changes. */
export async function gitIsClean(localPath: string): Promise<boolean> {
  try {
    const git = simpleGit(localPath);
    const status = await git.status();
    return status.isClean();
  } catch (err) {
    throw wrapGitError(err, "git status failed", { local_path: localPath });
  }
}

/**
 * Hard-reset the working tree + index of `localPath` to the given ref
 * (e.g. `"origin/HEAD"`). Used by the open-source mirror self-heal path
 * (v0.6 `SyncService.ensureMirrorClean`) to discard any hand-edits that
 * would otherwise block `git pull --ff-only`.
 *
 * Destructive by design. Callers MUST gate on `gitIsClean() === false`
 * AND repo kind (only open-source mirrors are valid recipients) before
 * invoking. See v0.6 spec §A1 for why custom repos are excluded.
 */
export async function gitResetHard(
  localPath: string,
  ref: string
): Promise<void> {
  try {
    const git = simpleGit(localPath);
    await git.raw(["reset", "--hard", ref]);
  } catch (err) {
    throw wrapGitError(err, "git reset --hard failed", {
      local_path: localPath,
      ref
    });
  }
}

/**
 * Attach a standard SimpleGit instance for advanced callers (e.g. log diff).
 * Rare — most code should use the typed helpers above.
 */
export function attachGit(localPath: string): SimpleGit {
  return simpleGit(localPath);
}

// ---------- Internal ----------

function wrapGitError(
  err: unknown,
  message: string,
  details: Record<string, unknown>
): AstackError {
  const stderr =
    err instanceof Error && "message" in err
      ? err.message
      : String(err);
  return new AstackError(ErrorCode.REPO_GIT_FAILED, message, {
    ...details,
    git_stderr: stderr
  });
}

function toIso(d: string | Date): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.valueOf())
    ? new Date().toISOString()
    : date.toISOString();
}
