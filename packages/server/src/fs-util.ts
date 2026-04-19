/**
 * Filesystem utilities for the sync engine.
 *
 * All functions operate on absolute paths and throw AstackError on failure
 * (FILESYSTEM_FAILED or SYMLINK_UNSUPPORTED / SYMLINK_TARGET_OCCUPIED).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { AstackError, ErrorCode } from "@astack/shared";

// ---------- Existence & kind probes ----------

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** True if p is a symlink (even if broken). Uses lstat. */
export function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Read symlink target; returns null if p is not a symlink. */
export function readSymlink(p: string): string | null {
  try {
    if (!fs.lstatSync(p).isSymbolicLink()) return null;
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

// ---------- Hashing ----------

/** SHA-256 hex of a file's contents; returns null if file is missing. */
export function hashFile(p: string): string | null {
  try {
    const data = fs.readFileSync(p);
    return crypto.createHash("sha256").update(data).digest("hex");
  } catch {
    return null;
  }
}

/**
 * SHA-256 over a directory: stable across runs, hashes the sorted list of
 * (relativePath, sha256ofContents) tuples. Returns null if dir missing.
 */
export function hashDir(p: string): string | null {
  if (!isDir(p)) return null;
  const entries = collectFiles(p).sort();
  const hash = crypto.createHash("sha256");
  for (const rel of entries) {
    const full = path.join(p, rel);
    const content = fs.readFileSync(full);
    hash.update(rel);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function collectFiles(root: string, prefix = ""): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectFiles(full, rel));
    } else if (entry.isFile()) {
      result.push(rel);
    }
    // Symlinks inside skills/ are ignored — scanning them is out of scope.
  }
  return result;
}

// ---------- Atomic file/dir operations ----------

/**
 * Write `contents` to `dest` atomically:
 *   1. write to sibling temp file
 *   2. rename over dest
 * Creates parent dirs as needed.
 */
export function writeFileAtomic(dest: string, contents: string): void {
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, dest);
  } catch (err) {
    throw wrapFsError(err, "write file failed", { dest });
  }
}

/**
 * Copy a file from src to dest, creating parent dirs. Overwrites existing
 * files. Uses COPYFILE_FICLONE when available for speed on APFS.
 */
export function copyFile(src: string, dest: string): void {
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_FICLONE);
  } catch (err) {
    throw wrapFsError(err, "copy file failed", { src, dest });
  }
}

/**
 * Recursively copy a directory tree. Creates dest; overwrites existing
 * files within; does not delete files in dest that aren't in src.
 *
 * For true sync semantics (src is the source of truth), call
 * `removeDirContent(dest)` first, then `copyDirContents`.
 */
export function copyDirContents(src: string, dest: string): void {
  try {
    if (!isDir(src)) {
      throw new Error(`source is not a directory: ${src}`);
    }
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const from = path.join(src, entry.name);
      const to = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDirContents(from, to);
      } else if (entry.isFile()) {
        fs.copyFileSync(from, to);
      }
    }
  } catch (err) {
    throw wrapFsError(err, "copy dir failed", { src, dest });
  }
}

/** Remove a directory (recursive) if it exists. */
export function removeDir(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (err) {
    throw wrapFsError(err, "remove dir failed", { path: p });
  }
}

/** Remove a single file if it exists. No-op if missing. */
export function removeFile(p: string): void {
  try {
    fs.rmSync(p, { force: true });
  } catch (err) {
    throw wrapFsError(err, "remove file failed", { path: p });
  }
}

/**
 * Mirror src → dest (delete dest first, then copy). Used for skill-directory
 * sync where we want the working copy to match upstream exactly.
 */
export function mirrorDir(src: string, dest: string): void {
  removeDir(dest);
  copyDirContents(src, dest);
}

// ---------- Symlinks ----------

/**
 * Create a symlink at `linkPath` pointing to `target`.
 *
 * Error semantics (design.md § Eng Review decision 3):
 *   - Symlink creation fails on Windows non-dev-mode → SYMLINK_UNSUPPORTED.
 *   - linkPath is already a real dir/file (not a symlink) → SYMLINK_TARGET_OCCUPIED.
 *   - linkPath is already a symlink pointing somewhere else → replaced.
 *
 * On POSIX, `target` should be a relative path from linkPath's parent
 * so the link is portable.
 */
export function createSymlink(linkPath: string, target: string): void {
  // Guard: refuse to overwrite a real directory/file.
  if (fs.existsSync(linkPath) && !isSymlink(linkPath)) {
    throw new AstackError(
      ErrorCode.SYMLINK_TARGET_OCCUPIED,
      "link path already occupied by a real file or directory",
      { link_path: linkPath }
    );
  }

  // Remove existing symlink if present, so we can overwrite.
  if (isSymlink(linkPath)) {
    fs.unlinkSync(linkPath);
  }

  fs.mkdirSync(path.dirname(linkPath), { recursive: true });

  try {
    // 'dir' hint helps on Windows; POSIX ignores it.
    fs.symlinkSync(target, linkPath, "dir");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      throw new AstackError(
        ErrorCode.SYMLINK_UNSUPPORTED,
        "symlink creation not permitted (Windows: enable Developer Mode)",
        { link_path: linkPath, target, error_code: code }
      );
    }
    throw wrapFsError(err, "symlink failed", { link_path: linkPath, target });
  }
}

/**
 * Evaluate a symlink's health.
 *   - active : link exists and points to a real dir/file matching expected
 *   - broken : link exists but target doesn't resolve
 *   - missing: link does not exist (caller decides if that's Removed vs Broken)
 */
export type SymlinkHealth = "active" | "broken" | "missing";

export function inspectSymlink(linkPath: string): SymlinkHealth {
  if (!isSymlink(linkPath)) {
    return fs.existsSync(linkPath) ? "broken" : "missing";
  }
  try {
    fs.statSync(linkPath); // follows the link
    return "active";
  } catch {
    return "broken";
  }
}

// ---------- Internal ----------

function wrapFsError(
  err: unknown,
  message: string,
  details: Record<string, unknown>
): AstackError {
  const errno = (err as NodeJS.ErrnoException).code;
  const detail =
    err instanceof Error ? err.message : String(err);
  return new AstackError(ErrorCode.FILESYSTEM_FAILED, message, {
    ...details,
    errno,
    error: detail
  });
}
