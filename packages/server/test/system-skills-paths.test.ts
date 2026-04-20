/**
 * Tests for system-skills/paths.ts + registry.ts (PR0).
 *
 * Contract: `systemSkillsRoot()` must resolve to a directory containing
 * `harness-init/SKILL.md`. Registry id is stable and equals the dir name.
 */

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  SYSTEM_SKILLS,
  SYSTEM_SKILL_IDS
} from "../src/system-skills/registry.js";
import { systemSkillsRoot } from "../src/system-skills/paths.js";

describe("systemSkillsRoot", () => {
  it("returns a directory containing harness-init/SKILL.md", () => {
    const root = systemSkillsRoot();
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.existsSync(path.join(root, "harness-init", "SKILL.md"))).toBe(
      true
    );
  });

  it("harness-init/scripts/init-harness.sh is present", () => {
    const root = systemSkillsRoot();
    const sh = path.join(root, "harness-init", "scripts", "init-harness.sh");
    expect(fs.existsSync(sh)).toBe(true);
  });

  it("harness-init/templates/ contains AGENTS.md.tpl", () => {
    const root = systemSkillsRoot();
    const tpl = path.join(
      root,
      "harness-init",
      "templates",
      "AGENTS.md.tpl"
    );
    expect(fs.existsSync(tpl)).toBe(true);
  });
});

describe("SYSTEM_SKILLS registry", () => {
  it("has exactly one entry (v0.4 ships only harness-init)", () => {
    expect(SYSTEM_SKILLS).toHaveLength(1);
    expect(SYSTEM_SKILLS[0].id).toBe("harness-init");
  });

  it("each registry id matches a real directory under systemSkillsRoot", () => {
    const root = systemSkillsRoot();
    for (const skill of SYSTEM_SKILLS) {
      const dir = path.join(root, skill.id);
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    }
  });

  it("SYSTEM_SKILL_IDS matches SYSTEM_SKILLS (fast-lookup set is consistent)", () => {
    const idsFromArray = new Set(SYSTEM_SKILLS.map((s) => s.id));
    expect([...SYSTEM_SKILL_IDS].sort()).toEqual([...idsFromArray].sort());
  });
});
