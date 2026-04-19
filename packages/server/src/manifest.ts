/**
 * `.astack.json` manifest reader/writer.
 *
 * Per design.md § Eng Review decision 2:
 *   `<project>/.claude/.astack.json` is the SOURCE OF TRUTH for a project's
 *   subscription list. SQLite mirrors it; on every `astack sync` or related
 *   operation we reconcile from file → SQLite (file wins).
 *
 * File shape (see design.md Manifest schema):
 *   {
 *     "project_id": 1,
 *     "server_url": "http://127.0.0.1:7432",
 *     "primary_tool": ".claude",
 *     "linked_tools": ["cursor", "codebuddy"],
 *     "subscriptions": [
 *       { "repo": "my-skills", "type": "command", "name": "code_review" },
 *       { "repo": "my-skills", "type": "skill",   "name": "office-hours" }
 *     ],
 *     "last_synced": "2026-04-19T11:30:00Z"
 *   }
 */

import fs from "node:fs";
import path from "node:path";

import {
  AstackError,
  ErrorCode,
  SkillType,
  type SkillType as SkillTypeT
} from "@astack/shared";
import { z } from "zod";

const ManifestSubscriptionSchema = z.object({
  repo: z.string().min(1),
  type: z.enum([SkillType.Command, SkillType.Skill]),
  name: z.string().min(1)
});

export const AstackManifestSchema = z.object({
  project_id: z.number().int().positive(),
  server_url: z.string().min(1),
  primary_tool: z.string().default(".claude"),
  linked_tools: z.array(z.string()).default([]),
  subscriptions: z.array(ManifestSubscriptionSchema).default([]),
  last_synced: z.string().nullable().default(null)
});

export type AstackManifest = z.infer<typeof AstackManifestSchema>;
export type ManifestSubscription = z.infer<typeof ManifestSubscriptionSchema>;

/** Relative location under the project root. */
export const MANIFEST_RELATIVE_PATH = ".claude/.astack.json";

export function manifestPath(projectPath: string, primaryTool = ".claude"): string {
  return path.join(projectPath, primaryTool, ".astack.json");
}

/**
 * Read and validate the manifest. Returns null if the file does not exist.
 * Throws AstackError(VALIDATION_FAILED) when the file exists but is malformed.
 */
export function readManifest(
  projectPath: string,
  primaryTool = ".claude"
): AstackManifest | null {
  const file = manifestPath(projectPath, primaryTool);
  if (!fs.existsSync(file)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new AstackError(
      ErrorCode.VALIDATION_FAILED,
      "manifest is not valid JSON",
      { file, error: (err as Error).message }
    );
  }
  const parsed = AstackManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AstackError(
      ErrorCode.VALIDATION_FAILED,
      "manifest failed schema validation",
      { file, issues: parsed.error.issues }
    );
  }
  return parsed.data;
}

/**
 * Write manifest atomically. Creates parent dirs as needed.
 */
export function writeManifest(
  projectPath: string,
  manifest: AstackManifest,
  primaryTool = ".claude"
): void {
  const file = manifestPath(projectPath, primaryTool);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export interface NormalizedSubscription {
  repo: string;
  type: SkillTypeT;
  name: string;
}

/**
 * Strip duplicate subscriptions (same repo/type/name) preserving the first
 * occurrence. Useful after merging CLI input with existing manifest state.
 */
export function dedupeSubscriptions(
  subs: ReadonlyArray<NormalizedSubscription>
): NormalizedSubscription[] {
  const seen = new Set<string>();
  const out: NormalizedSubscription[] = [];
  for (const s of subs) {
    const key = `${s.repo}/${s.type}/${s.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
