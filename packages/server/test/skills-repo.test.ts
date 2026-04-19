/**
 * Tests for SkillRepository (db/skills.ts).
 *
 * These cover the query and mutation paths used by SubscriptionService
 * and SyncService. In-memory SQLite per test.
 */

import { SkillType } from "@astack/shared";
import { beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Db } from "../src/db/connection.js";
import { SkillRepository } from "../src/db/skills.js";

function seedRepos(db: Db): { repoId1: number; repoId2: number } {
  db.prepare(
    `INSERT INTO skill_repos (name, git_url) VALUES ('r1', 'git@x:r1.git')`
  ).run();
  db.prepare(
    `INSERT INTO skill_repos (name, git_url) VALUES ('r2', 'git@x:r2.git')`
  ).run();
  return { repoId1: 1, repoId2: 2 };
}

describe("SkillRepository", () => {
  let db: Db;
  let skills: SkillRepository;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    skills = new SkillRepository(db);
    seedRepos(db);
  });

  describe("upsert", () => {
    it("inserts a new skill", () => {
      const row = skills.upsert({
        repo_id: 1,
        type: SkillType.Command,
        name: "code_review",
        path: "commands/code_review.md",
        version: "abc1234",
        updated_at: "2026-04-19T12:00:00.000Z"
      });
      expect(row.id).toBeGreaterThan(0);
      expect(row.name).toBe("code_review");
    });

    it("updates an existing skill on conflict", () => {
      const a = skills.upsert({
        repo_id: 1,
        type: SkillType.Command,
        name: "x",
        path: "commands/x.md",
        version: "v1",
        updated_at: "2026-04-19T12:00:00.000Z"
      });
      const b = skills.upsert({
        repo_id: 1,
        type: SkillType.Command,
        name: "x",
        path: "commands/x.md",
        version: "v2",
        updated_at: "2026-04-19T13:00:00.000Z"
      });
      expect(b.id).toBe(a.id);
      expect(b.version).toBe("v2");
    });
  });

  describe("find", () => {
    beforeEach(() => {
      skills.upsert({
        repo_id: 1,
        type: SkillType.Command,
        name: "shared",
        path: "commands/shared.md",
        version: "v1",
        updated_at: null
      });
      skills.upsert({
        repo_id: 2,
        type: SkillType.Command,
        name: "shared",
        path: "commands/shared.md",
        version: "v1",
        updated_at: null
      });
      skills.upsert({
        repo_id: 1,
        type: SkillType.Skill,
        name: "office-hours",
        path: "skills/office-hours",
        version: "v1",
        updated_at: null
      });
    });

    it("findById returns the row or null", () => {
      expect(skills.findById(1)?.name).toBe("shared");
      expect(skills.findById(9999)).toBeNull();
    });

    it("findByRef matches on (repo_id, type, name)", () => {
      const row = skills.findByRef(1, SkillType.Command, "shared");
      expect(row?.repo_id).toBe(1);
    });

    it("findByRef returns null when not found", () => {
      expect(skills.findByRef(1, SkillType.Command, "missing")).toBeNull();
    });

    it("findByShortName returns all matches across repos", () => {
      const matches = skills.findByShortName("shared");
      expect(matches).toHaveLength(2);
      expect(new Set(matches.map((m) => m.repo_id))).toEqual(new Set([1, 2]));
    });

    it("listByRepo returns only that repo's skills in a stable order", () => {
      const list = skills.listByRepo(1);
      expect(list.map((s) => [s.type, s.name])).toEqual([
        [SkillType.Command, "shared"],
        [SkillType.Skill, "office-hours"]
      ]);
    });
  });

  describe("delete", () => {
    beforeEach(() => {
      skills.upsert({
        repo_id: 1,
        type: SkillType.Command,
        name: "a",
        path: "commands/a.md",
        version: null,
        updated_at: null
      });
      skills.upsert({
        repo_id: 1,
        type: SkillType.Command,
        name: "b",
        path: "commands/b.md",
        version: null,
        updated_at: null
      });
      skills.upsert({
        repo_id: 2,
        type: SkillType.Command,
        name: "c",
        path: "commands/c.md",
        version: null,
        updated_at: null
      });
    });

    it("deleteByRepo drops all skills for a single repo", () => {
      const n = skills.deleteByRepo(1);
      expect(n).toBe(2);
      expect(skills.listByRepo(1)).toEqual([]);
      expect(skills.listByRepo(2)).toHaveLength(1);
    });

    it("deleteMissing keeps only the provided (type, name) set", () => {
      const n = skills.deleteMissing(1, [
        { type: SkillType.Command, name: "a" }
      ]);
      expect(n).toBe(1); // "b" removed
      expect(skills.listByRepo(1).map((s) => s.name)).toEqual(["a"]);
    });

    it("deleteMissing with empty present list deletes all for that repo", () => {
      const n = skills.deleteMissing(1, []);
      expect(n).toBe(2);
      expect(skills.listByRepo(1)).toEqual([]);
      // Other repo untouched.
      expect(skills.listByRepo(2)).toHaveLength(1);
    });
  });
});
