/**
 * Locate the bundled `system-skills/` directory on disk.
 *
 * System skills are astack-authored skill packages shipped inside
 * `@astack/server` itself (not cloned from user repos). v0.4 ships
 * exactly one: `harness-init`, which seeds the Harness governance
 * scaffolding into projects on register.
 *
 * Resolution mirrors `http/app.ts:locateDashboard` — try the npm
 * package export first (works for global installs), then fall back to
 * the pnpm workspace layout adjacent to `src/`.
 *
 * Throws INTERNAL when neither candidate exists; a broken install
 * manifests as missing system skills at startup, not silent degradation.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AstackError, ErrorCode } from "@astack/shared";

/**
 * Absolute path to the bundled system-skills root.
 *
 * Structure (at this root):
 *   <root>/
 *   └── harness-init/
 *       ├── SKILL.md
 *       ├── scripts/init-harness.sh
 *       └── templates/*.tpl
 *
 * Called once per daemon startup by `SystemSkillService` (and a smoke
 * test in paths.test.ts). Does not cache — the cost is a few fs.existsSync
 * calls, cheaper than adding invalidation logic.
 */
export function systemSkillsRoot(): string {
  const require_ = createRequire(import.meta.url);
  const candidates: string[] = [];

  // 1. Resolve via the package export (works in pnpm workspace + npm global).
  try {
    const pkg = require_.resolve("@astack/server/package.json");
    candidates.push(path.join(path.dirname(pkg), "system-skills"));
  } catch {
    // Package not available — fall through.
  }

  // 2. Adjacent to src/ in the monorepo (development fallback: tsx or vitest).
  //    __dirname resolves to .../packages/server/src/system-skills, so go up
  //    one level to .../packages/server/system-skills.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.join(here, "..", "..", "system-skills"));
  } catch {
    // ignore
  }

  // 3. Also try ../system-skills relative to compiled dist (packages/server/dist/system-skills/paths.js).
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.join(here, "..", "..", "..", "system-skills"));
  } catch {
    // ignore
  }

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "harness-init", "SKILL.md"))) {
      return c;
    }
  }
  throw new AstackError(
    ErrorCode.INTERNAL,
    "system-skills directory not found; astack install may be broken",
    { candidates }
  );
}
