/**
 * Tests for scanRepo.
 *
 * Uses tmp-promise to build small fixture directories rather than mocking fs.
 */

import fs from "node:fs";
import path from "node:path";

import { SkillType } from "@astack/shared";
import tmp from "tmp-promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scanRepo } from "../src/scanner.js";

describe("scanRepo", () => {
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
        relPath: "skills/office-hours"
      }
    ]);
  });

  it("warns (and skips) a skills/ dir missing SKILL.md", () => {
    fs.mkdirSync(path.join(dir.path, "skills", "broken"), { recursive: true });

    const result = scanRepo(dir.path);
    expect(result.skills).toEqual([]);
    expect(result.warnings).toEqual([
      "skipped skill without SKILL.md: skills/broken"
    ]);
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
});
