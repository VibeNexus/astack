/**
 * Scanner internal utilities shared across root-kind scanners.
 */

import fs from "node:fs";

/** Valid skill/command name: alphanumerics, underscore, hyphen. */
export const NAME_REGEX = /^[A-Za-z0-9_-]+$/;

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function safeReaddir(p: string): fs.Dirent[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}
