/**
 * Scan a root path for flat `*.md` files. Used by both:
 *   - `command-files` kind (e.g. `commands/*.md` → type='command')
 *   - `agent-files`   kind (e.g. `agents/*.md`   → type='agent')
 *
 * The only difference between command and agent is the resulting
 * SkillType; filesystem semantics are identical.
 */

import path from "node:path";

import { SkillType } from "@astack/shared";
import type { SkillType as SkillTypeT } from "@astack/shared";

import type { ScannedSkill } from "./index.js";
import { isDir, NAME_REGEX, safeReaddir } from "./common.js";
import { parseFrontmatter } from "./frontmatter.js";

export function scanFlatFiles(
  repoRoot: string,
  rootPath: string,
  out: ScannedSkill[],
  warnings: string[],
  resultType: SkillTypeT
): void {
  const dir = rootPath === "" ? repoRoot : path.join(repoRoot, rootPath);
  if (!isDir(dir)) return;

  for (const entry of safeReaddir(dir)) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    // README.md / LICENSE.md / NOTES.md are not commands. Heuristic:
    // only accept files whose basename (without .md) passes NAME_REGEX.
    const base = entry.name.slice(0, -3);
    const kindLabel = resultType === SkillType.Agent ? "agent" : "command";
    if (!NAME_REGEX.test(base)) {
      warnings.push(
        `skipped ${kindLabel} with invalid name: ${posixJoin(rootPath, entry.name)}`
      );
      continue;
    }

    const filePath = path.join(dir, entry.name);
    const fm = parseFrontmatter(filePath);
    if (fm.warning) warnings.push(fm.warning);

    if (fm.data.name && fm.data.name !== base) {
      warnings.push(
        `frontmatter name '${fm.data.name}' does not match file '${base}' at ${posixJoin(rootPath, entry.name)}`
      );
    }

    out.push({
      type: resultType,
      name: base,
      relPath: posixJoin(rootPath, entry.name),
      description: fm.data.description ?? null
    });
  }
}

function posixJoin(a: string, b: string): string {
  if (a === "") return b;
  return `${a}/${b}`;
}
