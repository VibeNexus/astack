/**
 * Hardcoded registry of system skills.
 *
 * v0.4 ships exactly one system skill (`harness-init`). Rather than
 * parsing YAML frontmatter from SKILL.md at startup (which would drag
 * in a dep and a failure surface for just one entry — see v0.4 spec
 * §A8 Issue 5 decision B), the `name` + `description` are hardcoded
 * here. When we add a second system skill, revisit: if the registry
 * exceeds ~3 entries or needs dynamic metadata, switch to parsing.
 *
 * IDs MUST equal the subdirectory name under `packages/server/system-skills/`.
 * The scanner (A9) uses these IDs as a blacklist to exclude same-named
 * skills from user-imported repos.
 */

export interface SystemSkillDescriptor {
  /** Stable id, also the directory name under system-skills/. */
  id: string;
  /** Human-readable label shown in UI. */
  name: string;
  /** Short description (copied from SKILL.md — keep in sync manually). */
  description: string;
}

export const SYSTEM_SKILLS: readonly SystemSkillDescriptor[] = [
  {
    id: "harness-init",
    name: "Harness governance bootstrap",
    description:
      "初始化或迁移项目的 Harness 研发流程治理基础设施（AGENTS.md + docs/version/ + docs/retro/），为 /spec /dev /code_review /mr /retro 等命令体系打底。"
  }
];

/** Fast id lookup for scanner filter / symlink service guard. */
export const SYSTEM_SKILL_IDS: ReadonlySet<string> = new Set(
  SYSTEM_SKILLS.map((s) => s.id)
);
