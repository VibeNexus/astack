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
  type: z.enum([SkillType.Command, SkillType.Skill, SkillType.Agent]),
  name: z.string().min(1)
});

/**
 * v0.5: an entry the user has explicitly told bootstrap to leave alone.
 *
 * Stored under `<project>/<primary_tool>/.astack.json` → `ignored_local`.
 * Bootstrap re-scan filters these out so they don't reappear in the
 * resolve-drawer.  See spec §A3 for why this lives in the manifest (team
 * coordination via git) rather than SQLite.
 */
const IgnoredLocalEntrySchema = z.object({
  type: z.enum([SkillType.Command, SkillType.Skill, SkillType.Agent]),
  name: z.string().min(1),
  /** ISO timestamp recorded for debugging — purely informational. */
  ignored_at: z.string().optional()
});

export const AstackManifestSchema = z.object({
  project_id: z.number().int().positive(),
  server_url: z.string().min(1),
  primary_tool: z.string().default(".claude"),
  linked_tools: z.array(z.string()).default([]),
  subscriptions: z.array(ManifestSubscriptionSchema).default([]),
  /** v0.5 — see §A3. Default `[]` keeps reads of older manifests safe. */
  ignored_local: z.array(IgnoredLocalEntrySchema).default([]),
  last_synced: z.string().nullable().default(null)
});

export type AstackManifest = z.infer<typeof AstackManifestSchema>;
export type ManifestSubscription = z.infer<typeof ManifestSubscriptionSchema>;
export type IgnoredLocalEntry = z.infer<typeof IgnoredLocalEntrySchema>;

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

/**
 * Strip duplicate ignored_local entries by (type, name), preserving the
 * first occurrence (so the original `ignored_at` survives). Used by
 * ProjectBootstrapService when appending new ignores to existing manifest
 * state — see v0.5 spec §A3.
 */
export function dedupeIgnoredLocal(
  entries: ReadonlyArray<IgnoredLocalEntry>
): IgnoredLocalEntry[] {
  const seen = new Set<string>();
  const out: IgnoredLocalEntry[] = [];
  for (const e of entries) {
    const key = `${e.type}/${e.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
