/**
 * Scan a root path for `skill-dirs`: subdirectories each containing a
 * SKILL.md manifest. Used for both the "standard" convention
 * (`skills/<n>/SKILL.md`) and the "flat" convention (`<n>/SKILL.md` at
 * repo root, as in garrytan/gstack).
 *
 * Whitelist principle: a subdirectory is a skill ONLY if it contains
 * SKILL.md. This naturally filters out `bin/`, `lib/`, `docs/`, `test/`,
 * `.git/`, `node_modules/`, etc. without hardcoded blacklists.
 *
 * Non-recursive: only first-level children of `rootPath` are considered.
 * This keeps flat-layout safe against symlink loops and prevents scanning
 * fixtures inside `test/` etc.
 */

import fs from "node:fs";
import path from "node:path";

import { SkillType } from "@astack/shared";

import type { ScannedSkill } from "./index.js";
import { isDir, NAME_REGEX, safeReaddir } from "./common.js";
import { parseFrontmatter } from "./frontmatter.js";

export function scanSkillDirs(
  repoRoot: string,
  rootPath: string,
  out: ScannedSkill[],
  warnings: string[]
): void {
  const dir = rootPath === "" ? repoRoot : path.join(repoRoot, rootPath);
  if (!isDir(dir)) return;

  for (const entry of safeReaddir(dir)) {
    if (!entry.isDirectory()) continue;
    // Always skip dotfiles at scanner level (e.g. `.git`, `.github`,
    // `.claude-plugin`). They're never skills.
    if (entry.name.startsWith(".")) continue;

    if (!NAME_REGEX.test(entry.name)) {
      warnings.push(
        `skipped skill with invalid name: ${posixJoin(rootPath, entry.name)}`
      );
      continue;
    }

    const skillDir = path.join(dir, entry.name);
    const manifest = path.join(skillDir, "SKILL.md");

    // Whitelist: must contain SKILL.md.
    if (!isFileSafe(manifest)) continue;

    // Read frontmatter (optional). Failures are non-fatal.
    const fm = parseFrontmatter(manifest);
    if (fm.warning) warnings.push(fm.warning);

    // If frontmatter.name exists and disagrees with the directory name,
    // trust the directory name but surface a warning.
    if (fm.data.name && fm.data.name !== entry.name) {
      warnings.push(
        `frontmatter name '${fm.data.name}' does not match directory '${entry.name}' at ${posixJoin(rootPath, entry.name)}/SKILL.md`
      );
    }

    out.push({
      type: SkillType.Skill,
      name: entry.name,
      relPath: posixJoin(rootPath, entry.name),
      description: fm.data.description ?? null
    });
  }
}

/**
 * Join path segments as a POSIX relative path. Empty leading segment
 * means "at the repo root", so we drop it to avoid a leading slash.
 */
function posixJoin(a: string, b: string): string {
  if (a === "") return b;
  return `${a}/${b}`;
}

function isFileSafe(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
