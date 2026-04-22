/**
 * Tests for shared zod schemas.
 *
 * Focus: validate the schemas guard the invariants described in design.md.
 * We don't test zod itself; we test our contract choices (defaults,
 * coercion, regex patterns, discriminated unions).
 */

import { describe, expect, it } from "vitest";

import {
  AstackEventSchema,
  CommitHashSchema,
  EventType,
  PaginationSchema,
  RegisterRepoRequestSchema,
  ResolveRequestSchema,
  ResolveStrategy,
  SkillRefStringSchema,
  SkillType,
  SubscribeRequestSchema,
  SyncRequestSchema
} from "../src/index.js";

describe("CommitHashSchema", () => {
  it("accepts 7-40 hex chars, case-insensitive", () => {
    expect(CommitHashSchema.safeParse("abc1234").success).toBe(true);
    expect(CommitHashSchema.safeParse("ABCDEF01234567890").success).toBe(true);
    expect(CommitHashSchema.safeParse("a".repeat(40)).success).toBe(true);
  });

  it("rejects non-hex and wrong length", () => {
    expect(CommitHashSchema.safeParse("abc").success).toBe(false); // < 7
    expect(CommitHashSchema.safeParse("a".repeat(41)).success).toBe(false); // > 40
    expect(CommitHashSchema.safeParse("xyz1234").success).toBe(false); // non-hex
  });
});

describe("SkillRefStringSchema", () => {
  it("accepts short, repo-qualified, and type-qualified forms", () => {
    expect(SkillRefStringSchema.safeParse("code_review").success).toBe(true);
    expect(SkillRefStringSchema.safeParse("my-skills/code_review").success).toBe(true);
    expect(
      SkillRefStringSchema.safeParse("my-skills/command/code_review").success
    ).toBe(true);
  });

  it("rejects deeper nesting and invalid chars", () => {
    expect(SkillRefStringSchema.safeParse("a/b/c/d").success).toBe(false);
    expect(SkillRefStringSchema.safeParse("has space").success).toBe(false);
    expect(SkillRefStringSchema.safeParse("").success).toBe(false);
  });
});

describe("PaginationSchema", () => {
  it("applies defaults when fields omitted", () => {
    const parsed = PaginationSchema.parse({});
    expect(parsed).toEqual({ offset: 0, limit: 50 });
  });

  it("coerces strings to numbers (query params arrive as strings)", () => {
    const parsed = PaginationSchema.parse({ offset: "20", limit: "100" });
    expect(parsed).toEqual({ offset: 20, limit: 100 });
  });

  it("caps limit at 500 to protect SQLite", () => {
    expect(PaginationSchema.safeParse({ limit: 501 }).success).toBe(false);
  });
});

describe("RegisterRepoRequestSchema", () => {
  it("requires git_url", () => {
    expect(RegisterRepoRequestSchema.safeParse({}).success).toBe(false);
  });

  it("accepts git_url alone (name is optional)", () => {
    const parsed = RegisterRepoRequestSchema.parse({
      git_url: "git@github.com:user/my-skills.git"
    });
    expect(parsed.name).toBeUndefined();
  });
});

describe("SubscribeRequestSchema", () => {
  it("defaults sync_now to true", () => {
    const parsed = SubscribeRequestSchema.parse({
      skills: ["code_review"]
    });
    expect(parsed.sync_now).toBe(true);
  });

  it("rejects empty skills array", () => {
    expect(
      SubscribeRequestSchema.safeParse({ skills: [] }).success
    ).toBe(false);
  });

  it("accepts optional type to disambiguate command vs skill", () => {
    const parsed = SubscribeRequestSchema.parse({
      skills: ["office-hours"],
      type: SkillType.Skill
    });
    expect(parsed.type).toBe(SkillType.Skill);
  });
});

describe("SyncRequestSchema", () => {
  it("has a default when body is omitted", () => {
    // Simulates empty POST body → server should accept.
    const parsed = SyncRequestSchema.parse(undefined);
    expect(parsed).toEqual({ force: false });
  });

  it("defaults force to false when skill_ids provided", () => {
    const parsed = SyncRequestSchema.parse({ skill_ids: [1, 2] });
    expect(parsed.force).toBe(false);
  });
});

describe("ResolveRequestSchema", () => {
  it("requires skill_id and strategy", () => {
    expect(ResolveRequestSchema.safeParse({}).success).toBe(false);
  });

  it("accepts each strategy value", () => {
    for (const strategy of Object.values(ResolveStrategy)) {
      const result = ResolveRequestSchema.safeParse({ skill_id: 1, strategy });
      expect(result.success, `rejected strategy: ${strategy}`).toBe(true);
    }
  });

  it("defaults manual_done to false", () => {
    const parsed = ResolveRequestSchema.parse({
      skill_id: 1,
      strategy: ResolveStrategy.Manual
    });
    expect(parsed.manual_done).toBe(false);
  });
});

describe("AstackEventSchema (SSE discriminated union)", () => {
  it("parses a well-formed hello event", () => {
    const msg = {
      type: EventType.Hello,
      payload: { server_version: "1.0.3", seq: 0 }
    };
    expect(AstackEventSchema.safeParse(msg).success).toBe(true);
  });

  it("parses a conflict_detected event", () => {
    const msg = {
      type: EventType.ConflictDetected,
      payload: {
        project_id: 1,
        skill: {
          id: 7,
          repo_id: 1,
          type: SkillType.Command,
          name: "code_review",
          path: "commands/code_review.md",
          description: null,
          version: "abc1234",
          updated_at: "2026-04-19T14:00:00.000Z"
        },
        log: {
          id: 42,
          project_id: 1,
          skill_id: 7,
          direction: "push",
          from_version: "def5678",
          to_version: null,
          status: "conflict",
          conflict_detail: "both sides modified",
          synced_at: "2026-04-19T14:00:00.000Z"
        },
        resolve_url: "/resolve/1/7"
      }
    };
    expect(AstackEventSchema.safeParse(msg).success).toBe(true);
  });

  it("rejects event with unknown type", () => {
    const msg = { type: "nope.unknown", payload: {} };
    expect(AstackEventSchema.safeParse(msg).success).toBe(false);
  });

  it("rejects event with type/payload shape mismatch", () => {
    // sync.completed expects synced/conflicts/errors, not a string.
    const msg = {
      type: EventType.SyncCompleted,
      payload: { project_id: 1, synced: "many" }
    };
    expect(AstackEventSchema.safeParse(msg).success).toBe(false);
  });
});
