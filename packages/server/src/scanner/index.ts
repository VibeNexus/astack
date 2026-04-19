/**
 * Skill repo scanner.
 *
 * Given an already-cloned repo directory and an optional `ScanConfig`,
 * walk the configured roots and yield `ScannedSkill` descriptors.
 *
 *   repoPath/
 *   ├── (roots walked per ScanConfig; default = standard layout)
 *   │   ├── skills/<n>/SKILL.md   → type='skill'
 *   │   └── commands/*.md         → type='command'
 *   └── astack.yaml               (optional metadata; currently ignored)
 *
 * Other supported layouts:
 *   - flat:       root-level `<n>/SKILL.md` (gstack)
 *   - multi-root: any combination of the root kinds above plus
 *                 `agents/*.md` (everything-claude-code)
 *
 * The scanner is pure: it does not touch SQLite. The caller (RepoService)
 * is responsible for upserting results.
 *
 * Contract: NEVER throws for malformed input. Malformed entries produce
 * warnings instead. A corrupted SKILL.md yields a valid ScannedSkill with
 * `description: null` plus a warning — we still record the skill exists.
 */

import {
  DEFAULT_SCAN_CONFIG,
  ScanRootKind,
  SkillType,
  type ScanConfig,
  type SkillType as SkillTypeT
} from "@astack/shared";

import { scanFlatFiles } from "./flat-files.js";
import { scanSkillDirs } from "./skill-dirs.js";

export interface ScannedSkill {
  type: SkillTypeT;
  /** Skill name (filename minus `.md`, or directory name). */
  name: string;
  /** Path relative to repo root (POSIX-style, forward slashes). */
  relPath: string;
  /** Human-readable description from SKILL.md frontmatter. */
  description: string | null;
}

export interface ScanResult {
  skills: ScannedSkill[];
  /** Warnings for malformed entries; safe to ignore, logged by caller. */
  warnings: string[];
}

/**
 * Scan a cloned repo. Returns all valid skills plus non-fatal warnings.
 *
 * @param repoPath   Absolute path to the cloned repo.
 * @param config     Scan layout. Defaults to the pre-v0.2 "standard"
 *                   convention: skills/<n>/SKILL.md + commands/*.md.
 */
export function scanRepo(
  repoPath: string,
  config: ScanConfig = DEFAULT_SCAN_CONFIG
): ScanResult {
  const skills: ScannedSkill[] = [];
  const warnings: string[] = [];

  for (const root of config.roots) {
    switch (root.kind) {
      case ScanRootKind.SkillDirs:
        scanSkillDirs(repoPath, root.path, skills, warnings);
        break;
      case ScanRootKind.CommandFiles:
        scanFlatFiles(repoPath, root.path, skills, warnings, SkillType.Command);
        break;
      case ScanRootKind.AgentFiles:
        scanFlatFiles(repoPath, root.path, skills, warnings, SkillType.Agent);
        break;
      default: {
        // Exhaustiveness: if a new ScanRootKind is added, TS will error here.
        const _exhaustive: never = root.kind;
        warnings.push(`unknown ScanRootKind: ${String(_exhaustive)}`);
      }
    }
  }

  // Deduplicate by (type, name) — a config could map the same skill twice
  // by mistake (e.g. two roots that overlap). Keep first occurrence.
  const seen = new Set<string>();
  const deduped: ScannedSkill[] = [];
  for (const s of skills) {
    const key = `${s.type}/${s.name}`;
    if (seen.has(key)) {
      warnings.push(`duplicate skill ignored: ${s.type}/${s.name} (${s.relPath})`);
      continue;
    }
    seen.add(key);
    deduped.push(s);
  }

  return { skills: deduped, warnings };
}
