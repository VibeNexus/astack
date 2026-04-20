/**
 * Builtin skill repos that SeedService clones on first daemon start.
 *
 * These are **opinionated** picks. Including them here means astack
 * actively distributes these repos to every user's machine. Consequences:
 *
 *   1. Legal: anthropics/skills has Apache-2.0 code alongside
 *      source-available assets (docx/pdf/pptx/xlsx/). Cloning into a
 *      user's workspace counts as distribution if that workspace ends
 *      up in CI / Docker / backups. Users who care should remove the
 *      seed — SeedService respects `seed_decisions.decision = 'removed'`.
 *
 *   2. Maintenance: third-party repos may change license, inject
 *      unexpected content, or disappear. We re-clone on every start,
 *      so that surface is real.
 *
 * Both risks were surfaced in the /plan-eng-review outside-voice pass
 * (see docs/version/v0.2-sqlite-and-multi-repo.md § 2 Known risks
 * accepted) and the user explicitly chose to accept them.
 *
 * Removing a seed from this list mid-life does NOT retract already-
 * cloned copies on existing machines — the user must run
 * `astack repos remove <name>` manually. That writes seed_decisions so
 * the repo won't come back on future starts even if we re-add it here.
 */

import { ScanRootKind, type ScanConfig } from "@astack/shared";

export interface BuiltinSeed {
  /**
   * Repo name — becomes the directory name under ~/.astack/repos/<name>
   * and the display name in the dashboard. Must match NAME_REGEX
   * (alphanumerics + underscore + hyphen).
   */
  name: string;
  /** HTTPS git URL (ssh:// and git:// are blocked by corp firewalls). */
  git_url: string;
  /** Layout override; matches the upstream repo's filesystem conventions. */
  scan_config: ScanConfig;
}

/**
 * The three builtin seeds.
 *
 * Pinned by URL (not by hash) so we always get the repo's current main.
 * If you want pinning, use `pinned_version` on the subscription layer.
 */
export const BUILTIN_SEEDS: readonly BuiltinSeed[] = [
  {
    // Anthropic's official skills repo. Standard layout: skills/<n>/SKILL.md.
    // No top-level commands/.
    name: "anthropic-skills",
    git_url: "https://github.com/anthropics/skills.git",
    scan_config: {
      roots: [{ path: "skills", kind: ScanRootKind.SkillDirs }]
    }
  },
  {
    // Garry Tan's gstack. FLAT layout: every SKILL.md-containing dir at
    // the repo root is a skill. bin/, lib/, docs/, extension/, hosts/,
    // test/, supabase/ etc. are NOT skills and get filtered by the
    // whitelist principle (must contain SKILL.md).
    name: "gstack",
    git_url: "https://github.com/garrytan/gstack.git",
    scan_config: {
      roots: [{ path: "", kind: ScanRootKind.SkillDirs }]
    }
  },
  {
    // affaan-m/everything-claude-code. Multi-root layout: skills/ for
    // skill dirs, commands/ for flat command markdowns, agents/ for
    // flat agent markdowns.
    name: "everything-claude-code",
    git_url: "https://github.com/affaan-m/everything-claude-code.git",
    scan_config: {
      roots: [
        { path: "skills", kind: ScanRootKind.SkillDirs },
        { path: "commands", kind: ScanRootKind.CommandFiles },
        { path: "agents", kind: ScanRootKind.AgentFiles }
      ]
    }
  }
] as const;

/**
 * True iff the given git URL belongs to a builtin seed. Used by
 * RepoService.remove() to decide whether to write a `seed_decisions`
 * row so the seed doesn't come back on next daemon start.
 */
export function isBuiltinSeedUrl(url: string): boolean {
  return BUILTIN_SEEDS.some((s) => s.git_url === url);
}
