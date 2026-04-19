/**
 * Skill repo scanner.
 *
 * Given an already-cloned repo directory, walk its `commands/` and
 * `skills/` subdirs and yield descriptors matching the structure
 * agreed in design.md § Eng Review decision 9:
 *
 *   <repo>/
 *   ├── commands/              *.md files → command skills
 *   ├── skills/<name>/SKILL.md → skill skills (dir must contain SKILL.md)
 *   └── astack.yaml            (optional metadata; currently ignored)
 *
 * The scanner is pure: it does not touch SQLite. The caller (RepoService)
 * is responsible for upserting results.
 */

import fs from "node:fs";
import path from "node:path";

import { SkillType } from "@astack/shared";
import type { SkillType as SkillTypeT } from "@astack/shared";

export interface ScannedSkill {
  type: SkillTypeT;
  /** Skill name (filename minus .md, or directory name). */
  name: string;
  /** Path relative to repo root (POSIX-style, forward slashes). */
  relPath: string;
}

export interface ScanResult {
  skills: ScannedSkill[];
  /** Warnings for malformed entries; safe to ignore, logged by caller. */
  warnings: string[];
}

/**
 * Scan a cloned repo. Returns all valid skills plus non-fatal warnings
 * for malformed entries (e.g. `skills/foo/` missing SKILL.md).
 *
 * Invalid filenames (not matching [A-Za-z0-9_-]+) are reported as warnings
 * and skipped — they'd break CLI refs.
 */
export function scanRepo(repoPath: string): ScanResult {
  const skills: ScannedSkill[] = [];
  const warnings: string[] = [];

  const commandsDir = path.join(repoPath, "commands");
  if (isDir(commandsDir)) {
    scanCommands(commandsDir, skills, warnings);
  }

  const skillsDir = path.join(repoPath, "skills");
  if (isDir(skillsDir)) {
    scanSkills(skillsDir, skills, warnings);
  }

  return { skills, warnings };
}

// ---------- Internal ----------

const NAME_REGEX = /^[A-Za-z0-9_-]+$/;

function scanCommands(
  dir: string,
  out: ScannedSkill[],
  warnings: string[]
): void {
  const entries = safeReaddir(dir);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    const base = entry.name.slice(0, -3);
    if (!NAME_REGEX.test(base)) {
      warnings.push(`skipped command with invalid name: commands/${entry.name}`);
      continue;
    }
    out.push({
      type: SkillType.Command,
      name: base,
      relPath: `commands/${entry.name}`
    });
  }
}

function scanSkills(
  dir: string,
  out: ScannedSkill[],
  warnings: string[]
): void {
  const entries = safeReaddir(dir);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!NAME_REGEX.test(entry.name)) {
      warnings.push(`skipped skill with invalid name: skills/${entry.name}`);
      continue;
    }
    const skillPath = path.join(dir, entry.name);
    const manifest = path.join(skillPath, "SKILL.md");
    if (!fs.existsSync(manifest)) {
      warnings.push(
        `skipped skill without SKILL.md: skills/${entry.name}`
      );
      continue;
    }
    out.push({
      type: SkillType.Skill,
      name: entry.name,
      relPath: `skills/${entry.name}`
    });
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeReaddir(p: string): fs.Dirent[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}
