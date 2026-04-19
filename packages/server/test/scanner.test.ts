/**
 * Tests for scanRepo (scanner/ module).
 *
 * Uses tmp-promise to build small fixture directories rather than mocking fs.
 *
 * Coverage:
 *  - Default layout (skills/<n>/SKILL.md + commands/*.md) — regressions
 *    from pre-v0.2 behavior. NOTE: the "missing SKILL.md warning" was
 *    intentionally removed in v0.2 because the whitelist principle makes
 *    it noisy for flat-layout repos (e.g. gstack's bin/ at repo root).
 *  - Flat layout (root-level <n>/SKILL.md) — gstack.
 *  - Multi-root layout with commands + agents + skills — affaan-m/ECC.
 *  - Frontmatter parsing (name/description, edge cases).
 *  - Dedup across overlapping roots.
 */

import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_SCAN_CONFIG,
  ScanRootKind,
  SkillType,
  type ScanConfig
} from "@astack/shared";
import tmp from "tmp-promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scanRepo } from "../src/scanner/index.js";

describe("scanRepo — default (standard) layout", () => {
  let dir: tmp.DirectoryResult;

  beforeEach(async () => {
    dir = await tmp.dir({ unsafeCleanup: true });
  });
  afterEach(async () => {
    await dir.cleanup();
  });

  it("returns empty skills and no warnings on empty repo", () => {
    const result = scanRepo(dir.path);
    expect(result).toEqual({ skills: [], warnings: [] });
  });

  it("discovers commands (*.md files under commands/)", () => {
    fs.mkdirSync(path.join(dir.path, "commands"), { recursive: true });
    fs.writeFileSync(path.join(dir.path, "commands", "code_review.md"), "x");
    fs.writeFileSync(path.join(dir.path, "commands", "spec.md"), "y");

    const result = scanRepo(dir.path);
    expect(result.warnings).toEqual([]);
    expect(result.skills).toHaveLength(2);
    const names = result.skills.map((s) => s.name).sort();
    expect(names).toEqual(["code_review", "spec"]);
    for (const s of result.skills) {
      expect(s.type).toBe(SkillType.Command);
      expect(s.relPath).toMatch(/^commands\//);
      expect(s.description).toBeNull();
    }
  });

  it("discovers skills (directories with SKILL.md under skills/)", () => {
    fs.mkdirSync(path.join(dir.path, "skills", "office-hours"), {
      recursive: true
    });
    fs.writeFileSync(
      path.join(dir.path, "skills", "office-hours", "SKILL.md"),
      "x"
    );

    const result = scanRepo(dir.path);
    expect(result.warnings).toEqual([]);
    expect(result.skills).toEqual([
      {
        type: SkillType.Skill,
        name: "office-hours",
        relPath: "skills/office-hours",
        description: null
      }
    ]);
  });

  it("silently skips a skills/ dir missing SKILL.md (whitelist principle)", () => {
    fs.mkdirSync(path.join(dir.path, "skills", "broken"), { recursive: true });

    const result = scanRepo(dir.path);
    expect(result.skills).toEqual([]);
    // No warning: the whitelist principle means "only dirs with SKILL.md
    // count", and we don't want to warn for every non-skill dir a repo
    // might happen to have inside skills/.
    expect(result.warnings).toEqual([]);
  });

  it("warns (and skips) invalid filenames in commands/", () => {
    fs.mkdirSync(path.join(dir.path, "commands"), { recursive: true });
    fs.writeFileSync(path.join(dir.path, "commands", "bad name.md"), "x");

    const result = scanRepo(dir.path);
    expect(result.skills).toEqual([]);
    expect(result.warnings).toEqual([
      "skipped command with invalid name: commands/bad name.md"
    ]);
  });

  it("warns (and skips) invalid dir names in skills/", () => {
    fs.mkdirSync(path.join(dir.path, "skills", "bad name"), { recursive: true });
    fs.writeFileSync(
      path.join(dir.path, "skills", "bad name", "SKILL.md"),
      "x"
    );

    const result = scanRepo(dir.path);
    expect(result.skills).toEqual([]);
    expect(result.warnings).toEqual([
      "skipped skill with invalid name: skills/bad name"
    ]);
  });

  it("ignores non-.md files in commands/", () => {
    fs.mkdirSync(path.join(dir.path, "commands"), { recursive: true });
    fs.writeFileSync(path.join(dir.path, "commands", "readme.txt"), "x");
    fs.writeFileSync(path.join(dir.path, "commands", "valid.md"), "y");

    const result = scanRepo(dir.path);
    expect(result.skills.map((s) => s.name)).toEqual(["valid"]);
  });

  it("ignores loose files in skills/ (only directories count)", () => {
    fs.mkdirSync(path.join(dir.path, "skills"), { recursive: true });
    fs.writeFileSync(path.join(dir.path, "skills", "loose.md"), "x");

    const result = scanRepo(dir.path);
    expect(result.skills).toEqual([]);
  });

  it("omitting config argument is equivalent to DEFAULT_SCAN_CONFIG", () => {
    fs.mkdirSync(path.join(dir.path, "commands"), { recursive: true });
    fs.writeFileSync(path.join(dir.path, "commands", "x.md"), "y");
    fs.mkdirSync(path.join(dir.path, "skills", "y"), { recursive: true });
    fs.writeFileSync(path.join(dir.path, "skills", "y", "SKILL.md"), "z");

    const defaultResult = scanRepo(dir.path);
    const explicitResult = scanRepo(dir.path, DEFAULT_SCAN_CONFIG);
    expect(defaultResult).toEqual(explicitResult);
  });
});

describe("scanRepo — flat layout (gstack-style)", () => {
  let dir: tmp.DirectoryResult;
  const flatConfig: ScanConfig = {
    roots: [{ path: "", kind: ScanRootKind.SkillDirs }]
  };

  beforeEach(async () => {
    dir = await tmp.dir({ unsafeCleanup: true });
  });
  afterEach(async () => {
    await dir.cleanup();
  });

  it("discovers root-level dirs that contain SKILL.md", () => {
    // Three "skill" dirs, one "non-skill" dir (no SKILL.md).
    for (const name of ["review", "qa", "ship"]) {
      fs.mkdirSync(path.join(dir.path, name), { recursive: true });
      fs.writeFileSync(path.join(dir.path, name, "SKILL.md"), "x");
    }
    fs.mkdirSync(path.join(dir.path, "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir.path, "bin", "script.sh"), "#!/bin/sh\n");

    const result = scanRepo(dir.path, flatConfig);
    expect(result.warnings).toEqual([]);
    expect(result.skills.map((s) => s.name).sort()).toEqual([
      "qa",
      "review",
      "ship"
    ]);
    for (const s of result.skills) {
      expect(s.type).toBe(SkillType.Skill);
      expect(s.relPath).not.toContain("/"); // root-level
    }
  });

  it("ignores dotfile directories at the repo root", () => {
    fs.mkdirSync(path.join(dir.path, ".git"), { recursive: true });
    fs.writeFileSync(path.join(dir.path, ".git", "SKILL.md"), "fake");
    fs.mkdirSync(path.join(dir.path, ".github"), { recursive: true });
    fs.writeFileSync(path.join(dir.path, ".github", "SKILL.md"), "fake");
    fs.mkdirSync(path.join(dir.path, "real-skill"), { recursive: true });
    fs.writeFileSync(
      path.join(dir.path, "real-skill", "SKILL.md"),
      "x"
    );

    const result = scanRepo(dir.path, flatConfig);
    expect(result.skills.map((s) => s.name)).toEqual(["real-skill"]);
    expect(result.warnings).toEqual([]);
  });

  it("does not recurse into subdirectories (only first level)", () => {
    fs.mkdirSync(path.join(dir.path, "outer", "inner"), { recursive: true });
    fs.writeFileSync(
      path.join(dir.path, "outer", "inner", "SKILL.md"),
      "x"
    );
    // outer/ itself has no SKILL.md, so it should NOT be picked up,
    // and the nested inner/ should not be discovered either.

    const result = scanRepo(dir.path, flatConfig);
    expect(result.skills).toEqual([]);
  });

  it("warns on invalid root-dir names", () => {
    fs.mkdirSync(path.join(dir.path, "bad name"), { recursive: true });
    fs.writeFileSync(path.join(dir.path, "bad name", "SKILL.md"), "x");

    const result = scanRepo(dir.path, flatConfig);
    expect(result.skills).toEqual([]);
    expect(result.warnings).toEqual([
      "skipped skill with invalid name: bad name"
    ]);
  });
});

describe("scanRepo — multi-root layout (ECC-style)", () => {
  let dir: tmp.DirectoryResult;
  const multiConfig: ScanConfig = {
    roots: [
      { path: "skills", kind: ScanRootKind.SkillDirs },
      { path: "commands", kind: ScanRootKind.CommandFiles },
      { path: "agents", kind: ScanRootKind.AgentFiles }
    ]
  };

  beforeEach(async () => {
    dir = await tmp.dir({ unsafeCleanup: true });
  });
  afterEach(async () => {
    await dir.cleanup();
  });

  it("discovers skills + commands + agents in one pass", () => {
    fs.mkdirSync(path.join(dir.path, "skills", "plan"), { recursive: true });
    fs.writeFileSync(path.join(dir.path, "skills", "plan", "SKILL.md"), "x");
    fs.mkdirSync(path.join(dir.path, "commands"), { recursive: true });
    fs.writeFileSync(path.join(dir.path, "commands", "review.md"), "x");
    fs.mkdirSync(path.join(dir.path, "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(dir.path, "agents", "code-reviewer.md"),
      "x"
    );

    const result = scanRepo(dir.path, multiConfig);
    expect(result.warnings).toEqual([]);
    const byType = {
      skill: result.skills.filter((s) => s.type === SkillType.Skill).map((s) => s.name),
      command: result.skills.filter((s) => s.type === SkillType.Command).map((s) => s.name),
      agent: result.skills.filter((s) => s.type === SkillType.Agent).map((s) => s.name)
    };
    expect(byType.skill).toEqual(["plan"]);
    expect(byType.command).toEqual(["review"]);
    expect(byType.agent).toEqual(["code-reviewer"]);
  });

  it("skips a missing root directory silently", () => {
    // Only skills/ present; commands/ and agents/ missing.
    fs.mkdirSync(path.join(dir.path, "skills", "plan"), { recursive: true });
    fs.writeFileSync(path.join(dir.path, "skills", "plan", "SKILL.md"), "x");

    const result = scanRepo(dir.path, multiConfig);
    expect(result.warnings).toEqual([]);
    expect(result.skills.map((s) => s.name)).toEqual(["plan"]);
  });

  it("deduplicates when two roots produce the same (type, name) pair", () => {
    // Pathological: two roots that both resolve the same name.
    // We keep the first occurrence and warn.
    const dupConfig: ScanConfig = {
      roots: [
        { path: "a", kind: ScanRootKind.CommandFiles },
        { path: "b", kind: ScanRootKind.CommandFiles }
      ]
    };
    fs.mkdirSync(path.join(dir.path, "a"), { recursive: true });
    fs.writeFileSync(path.join(dir.path, "a", "dup.md"), "x");
    fs.mkdirSync(path.join(dir.path, "b"), { recursive: true });
    fs.writeFileSync(path.join(dir.path, "b", "dup.md"), "y");

    const result = scanRepo(dir.path, dupConfig);
    expect(result.skills.map((s) => s.name)).toEqual(["dup"]);
    expect(result.skills[0]!.relPath).toBe("a/dup.md");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/duplicate skill ignored/);
  });
});

describe("scanRepo — frontmatter parsing", () => {
  let dir: tmp.DirectoryResult;

  beforeEach(async () => {
    dir = await tmp.dir({ unsafeCleanup: true });
  });
  afterEach(async () => {
    await dir.cleanup();
  });

  it("reads description from SKILL.md YAML frontmatter", () => {
    fs.mkdirSync(path.join(dir.path, "skills", "myskill"), { recursive: true });
    fs.writeFileSync(
      path.join(dir.path, "skills", "myskill", "SKILL.md"),
      `---
name: myskill
description: Does the thing well.
---

# Body
`
    );

    const result = scanRepo(dir.path);
    expect(result.warnings).toEqual([]);
    expect(result.skills[0]!.description).toBe("Does the thing well.");
  });

  it("reads description from command frontmatter (agents same path)", () => {
    fs.mkdirSync(path.join(dir.path, "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(dir.path, "commands", "review.md"),
      `---
description: Review code carefully.
---
body`
    );
    const result = scanRepo(dir.path);
    expect(result.skills[0]!.description).toBe("Review code carefully.");
  });

  it("returns null description when frontmatter absent", () => {
    fs.mkdirSync(path.join(dir.path, "skills", "x"), { recursive: true });
    fs.writeFileSync(
      path.join(dir.path, "skills", "x", "SKILL.md"),
      "# Just a heading, no frontmatter\n"
    );
    const result = scanRepo(dir.path);
    expect(result.skills[0]!.description).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("warns on YAML syntax error and continues with null description", () => {
    fs.mkdirSync(path.join(dir.path, "skills", "y"), { recursive: true });
    fs.writeFileSync(
      path.join(dir.path, "skills", "y", "SKILL.md"),
      `---
this is :: not : valid : yaml :: [
---
body`
    );
    const result = scanRepo(dir.path);
    // Skill is still recorded — we don't lose it over a broken frontmatter.
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.description).toBeNull();
    expect(result.warnings.some((w) => /YAML frontmatter parse error/.test(w))).toBe(
      true
    );
  });

  it("warns on non-UTF-8 bytes in SKILL.md", () => {
    fs.mkdirSync(path.join(dir.path, "skills", "z"), { recursive: true });
    // Write invalid UTF-8 bytes: 0xFF is never valid UTF-8.
    const bad = Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]);
    fs.writeFileSync(path.join(dir.path, "skills", "z", "SKILL.md"), bad);

    const result = scanRepo(dir.path);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.description).toBeNull();
    expect(result.warnings.some((w) => /non-UTF-8/.test(w))).toBe(true);
  });

  it("warns when frontmatter name disagrees with directory name (dir wins)", () => {
    fs.mkdirSync(path.join(dir.path, "skills", "actual-dir-name"), {
      recursive: true
    });
    fs.writeFileSync(
      path.join(dir.path, "skills", "actual-dir-name", "SKILL.md"),
      `---
name: different-name-in-yaml
description: hi
---`
    );
    const result = scanRepo(dir.path);
    expect(result.skills[0]!.name).toBe("actual-dir-name");
    expect(result.warnings.some((w) => /does not match directory/.test(w))).toBe(
      true
    );
  });

  it("warns when frontmatter name disagrees with command filename (file wins)", () => {
    fs.mkdirSync(path.join(dir.path, "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(dir.path, "commands", "on-disk.md"),
      `---
name: different
description: x
---`
    );
    const result = scanRepo(dir.path);
    expect(result.skills[0]!.name).toBe("on-disk");
    expect(result.warnings.some((w) => /does not match file/.test(w))).toBe(
      true
    );
  });
});
