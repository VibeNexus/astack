/**
 * Parse YAML frontmatter from a SKILL.md / *.md file.
 *
 * Contract (see v0.2 Spec § PR1 Code Quality):
 *   - Returns `{ name?: string; description?: string }` on success. Only
 *     these two fields are read in v0.2. Unknown fields are ignored.
 *   - On ANY failure (read error, non-UTF-8 bytes, YAML syntax error,
 *     no `---` delimiters), returns `{}` plus a `warning: string` so the
 *     caller can decide what to surface.
 *   - Never throws. The scanner must tolerate a broken skill file and
 *     continue walking the rest of the tree.
 *
 * The `name` from frontmatter is NOT trusted when it conflicts with the
 * directory/file name — the directory name wins. Callers should surface
 * a warning when they detect a mismatch.
 */

import fs from "node:fs";

import matter from "gray-matter";

export interface FrontmatterResult {
  data: { name?: string; description?: string };
  warning?: string;
}

export function parseFrontmatter(filePath: string): FrontmatterResult {
  let content: string;
  try {
    // gray-matter reads buffer; we go through readFileSync to surface
    // permission / missing-file errors explicitly and keep control over
    // the decode step.
    const buf = fs.readFileSync(filePath);
    // Detect non-UTF-8 by checking for replacement char after utf8 decode.
    content = buf.toString("utf8");
    // U+FFFD is what Node substitutes for invalid byte sequences.
    // If the file legitimately contains U+FFFD it's not a frontmatter
    // concern, but it's a strong enough signal to warn on.
    if (content.includes("\uFFFD")) {
      return {
        data: {},
        warning: `non-UTF-8 bytes in ${filePath}`
      };
    }
  } catch (err) {
    return {
      data: {},
      warning: `failed to read ${filePath}: ${(err as Error).message}`
    };
  }

  // Quick shortcut: no `---` at all means no frontmatter.
  if (!content.startsWith("---")) {
    return { data: {} };
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch (err) {
    return {
      data: {},
      warning: `YAML frontmatter parse error in ${filePath}: ${(err as Error).message}`
    };
  }

  const raw = parsed.data as Record<string, unknown>;
  const out: FrontmatterResult["data"] = {};
  if (typeof raw.name === "string" && raw.name.length > 0) {
    out.name = raw.name;
  }
  if (typeof raw.description === "string" && raw.description.length > 0) {
    out.description = raw.description;
  }
  return { data: out };
}
