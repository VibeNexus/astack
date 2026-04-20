/**
 * Tests for A9 scanner filter (PR2.5).
 *
 * Verifies that user-imported repos carrying a skill named the same as a
 * system skill (e.g. `harness-init`) get excluded from scan results with
 * a warning, while commands / agents with the same name are unaffected.
 */

import fs from "node:fs";
import path from "node:path";

import tmp from "tmp-promise";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_SCAN_CONFIG } from "@astack/shared";

import { scanRepo } from "../src/scanner/index.js";

async function mkRepo(layout: {
  skills?: Array<{ name: string; skillMd?: string }>;
  commands?: string[];
}): Promise<{ dir: tmp.DirectoryResult; path: string }> {
  const dir = await tmp.dir({ unsafeCleanup: true });
  if (layout.skills) {
    for (const s of layout.skills) {
      const d = path.join(dir.path, "skills", s.name);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(
        path.join(d, "SKILL.md"),
        s.skillMd ?? "---\nname: " + s.name + "\ndescription: test\n---\n"
      );
    }
  }
  if (layout.commands) {
    const cmdDir = path.join(dir.path, "commands");
    fs.mkdirSync(cmdDir, { recursive: true });
    for (const name of layout.commands) {
      fs.writeFileSync(
        path.join(cmdDir, name + ".md"),
        "---\ndescription: cmd\n---\nbody"
      );
    }
  }
  return { dir, path: dir.path };
}

describe("scanRepo — systemSkillIds filter (A9)", () => {
  const repos: tmp.DirectoryResult[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const d = repos.pop();
      if (d) await d.cleanup();
    }
  });

  it("filters a type=skill whose name collides with a system skill id", async () => {
    const r = await mkRepo({
      skills: [{ name: "harness-init" }, { name: "foo" }]
    });
    repos.push(r.dir);

    const result = scanRepo(r.path, DEFAULT_SCAN_CONFIG, {
      systemSkillIds: new Set(["harness-init"])
    });

    const names = result.skills.map((s) => s.name).sort();
    expect(names).toEqual(["foo"]);
    expect(
      result.warnings.some((w) => w.includes("harness-init") && w.includes("reserved"))
    ).toBe(true);
  });

  it("no filter when systemSkillIds is omitted (v0.3 behavior preserved)", async () => {
    const r = await mkRepo({ skills: [{ name: "harness-init" }, { name: "foo" }] });
    repos.push(r.dir);

    const result = scanRepo(r.path, DEFAULT_SCAN_CONFIG);
    const names = result.skills.map((s) => s.name).sort();
    expect(names).toEqual(["foo", "harness-init"]);
    expect(result.warnings.filter((w) => w.includes("reserved"))).toHaveLength(
      0
    );
  });

  it("empty systemSkillIds set is equivalent to omitting the option", async () => {
    const r = await mkRepo({ skills: [{ name: "harness-init" }] });
    repos.push(r.dir);

    const result = scanRepo(r.path, DEFAULT_SCAN_CONFIG, {
      systemSkillIds: new Set<string>()
    });
    expect(result.skills.map((s) => s.name)).toEqual(["harness-init"]);
  });

  it("a command named 'harness-init' is NOT filtered (commands live elsewhere)", async () => {
    const r = await mkRepo({
      commands: ["harness-init"],
      skills: [{ name: "foo" }]
    });
    repos.push(r.dir);

    const result = scanRepo(r.path, DEFAULT_SCAN_CONFIG, {
      systemSkillIds: new Set(["harness-init"])
    });
    // commands/harness-init.md survives (type=command, not type=skill).
    const commands = result.skills.filter((s) => s.type === "command");
    expect(commands.map((s) => s.name)).toContain("harness-init");
  });

  it("filter preserves other skills in the same repo", async () => {
    const r = await mkRepo({
      skills: [
        { name: "harness-init" },
        { name: "alpha" },
        { name: "beta" }
      ]
    });
    repos.push(r.dir);

    const result = scanRepo(r.path, DEFAULT_SCAN_CONFIG, {
      systemSkillIds: new Set(["harness-init"])
    });
    expect(result.skills.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
  });
});
