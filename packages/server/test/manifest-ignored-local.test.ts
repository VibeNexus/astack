/**
 * PR1 regression tests for v0.5 ignored_local manifest field.
 *
 * Covers spec §PR1 test list:
 *   - schema reads of legacy manifests default ignored_local to []
 *   - roundtrip preserves the field
 *   - dedupeIgnoredLocal preserves first occurrence
 *   - rewriteManifest preserves ignored_local across subscribe / unsubscribe
 *     (R3 — schema extension + write path bound atomically in PR1)
 *   - first-time write (no existing manifest) emits ignored_local: []
 */

import fs from "node:fs";

import tmp from "tmp-promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SkillType } from "@astack/shared";

import {
  AstackManifestSchema,
  dedupeIgnoredLocal,
  manifestPath,
  readManifest,
  writeManifest,
  type AstackManifest,
  type IgnoredLocalEntry
} from "../src/manifest.js";

import { createHarness, type Harness } from "./helpers/harness.js";

// ---------- Schema layer (no harness needed) ----------

describe("AstackManifestSchema — ignored_local", () => {
  it("defaults missing field to [] when reading a legacy manifest", () => {
    const raw = {
      project_id: 1,
      server_url: "http://localhost",
      primary_tool: ".claude",
      linked_tools: [],
      subscriptions: [],
      last_synced: null
    };
    const parsed = AstackManifestSchema.parse(raw);
    expect(parsed.ignored_local).toEqual([]);
  });

  it("roundtrips ignored_local via writeManifest + readManifest", async () => {
    const dir = await tmp.dir({ unsafeCleanup: true });
    try {
      const manifest: AstackManifest = {
        project_id: 1,
        server_url: "http://localhost",
        primary_tool: ".claude",
        linked_tools: [],
        subscriptions: [],
        ignored_local: [
          {
            type: SkillType.Skill,
            name: "abc",
            ignored_at: "2026-04-21T00:00:00Z"
          }
        ],
        last_synced: null
      };
      writeManifest(dir.path, manifest, ".claude");

      const back = readManifest(dir.path, ".claude");
      expect(back).not.toBeNull();
      expect(back?.ignored_local).toEqual([
        {
          type: SkillType.Skill,
          name: "abc",
          ignored_at: "2026-04-21T00:00:00Z"
        }
      ]);
    } finally {
      await dir.cleanup();
    }
  });
});

describe("dedupeIgnoredLocal", () => {
  it("removes duplicate (type, name) entries preserving first occurrence", () => {
    const entries: IgnoredLocalEntry[] = [
      {
        type: SkillType.Skill,
        name: "abc",
        ignored_at: "2026-04-21T00:00:00Z"
      },
      {
        type: SkillType.Skill,
        name: "abc",
        ignored_at: "2026-04-22T00:00:00Z"
      },
      { type: SkillType.Command, name: "abc" },
      { type: SkillType.Skill, name: "xyz" }
    ];
    const out = dedupeIgnoredLocal(entries);
    expect(out).toEqual([
      {
        type: SkillType.Skill,
        name: "abc",
        ignored_at: "2026-04-21T00:00:00Z"
      },
      { type: SkillType.Command, name: "abc" },
      { type: SkillType.Skill, name: "xyz" }
    ]);
  });
});

// ---------- rewriteManifest behaviour (R3) ----------

describe("rewriteManifest — preserves ignored_local across subscribe/unsubscribe", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  /**
   * Common setup: a registered repo with one command + one skill, plus a
   * registered project under h.projectDir.
   */
  async function seed(): Promise<{
    projectId: number;
    skillIdCommand: number;
  }> {
    await h.bare.addCommitPush(
      "commands/code_review.md",
      "# code review\n",
      "add code_review"
    );
    const { repo } = await h.repoService.register({ git_url: h.bare.url });
    const project = h.projectService.register({ path: h.projectDir.path });
    const skills = h.repoService.listSkills(repo.id);
    const cmd = skills.find((s) => s.type === SkillType.Command)!;
    return { projectId: project.id, skillIdCommand: cmd.id };
  }

  it("subscribe()'s rewriteManifest call keeps an existing ignored_local entry", async () => {
    const { projectId } = await seed();

    // After register, no manifest exists yet (subscribe creates it).
    // Pre-seed manifest with an ignored entry that matches the project.
    const seedManifest: AstackManifest = {
      project_id: projectId,
      server_url: "http://127.0.0.1:7432",
      primary_tool: ".claude",
      linked_tools: [],
      subscriptions: [],
      ignored_local: [
        {
          type: SkillType.Skill,
          name: "xyz",
          ignored_at: "2026-04-21T00:00:00Z"
        }
      ],
      last_synced: null
    };
    writeManifest(h.projectDir.path, seedManifest, ".claude");

    h.subscriptionService.subscribe(projectId, "code_review");

    const back = readManifest(h.projectDir.path, ".claude");
    expect(back?.ignored_local).toEqual([
      {
        type: SkillType.Skill,
        name: "xyz",
        ignored_at: "2026-04-21T00:00:00Z"
      }
    ]);
    expect(back?.subscriptions).toHaveLength(1);
    expect(back?.subscriptions[0]).toMatchObject({
      type: SkillType.Command,
      name: "code_review"
    });
  });

  it("unsubscribe()'s rewriteManifest call leaves ignored_local as [] when there were none", async () => {
    const { projectId, skillIdCommand } = await seed();

    h.subscriptionService.subscribe(projectId, "code_review");
    const before = readManifest(h.projectDir.path, ".claude");
    expect(before?.ignored_local).toEqual([]);

    h.subscriptionService.unsubscribe(projectId, skillIdCommand);

    const after = readManifest(h.projectDir.path, ".claude");
    expect(after?.ignored_local).toEqual([]);
    expect(after?.subscriptions).toEqual([]);
  });

  it("first-time write (no existing manifest) emits ignored_local: []", async () => {
    const { projectId } = await seed();
    // Make sure no manifest exists yet.
    const file = manifestPath(h.projectDir.path, ".claude");
    if (fs.existsSync(file)) fs.rmSync(file);

    h.subscriptionService.subscribe(projectId, "code_review");

    const m = readManifest(h.projectDir.path, ".claude");
    expect(m).not.toBeNull();
    expect(m?.ignored_local).toEqual([]);
  });
});
