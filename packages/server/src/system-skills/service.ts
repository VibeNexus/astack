/**
 * System-skill management service (v0.4).
 *
 * Owns the bundled `harness-init` skill's lifecycle inside projects:
 *   - seed        : force-overwrite the project's copy (Re-install button)
 *   - seedIfMissing: seed only when target dir doesn't exist (register path)
 *   - inspect     : pure read; returns HarnessStatus + drift diagnostics
 *
 * Built-in version is the single source of truth — a project's modified
 * copy is reported as "drift" but never silently reconciled. Only explicit
 * `seed` (or `seedIfMissing` into an empty slot) writes to disk.
 *
 * Concurrency:
 *   Per-project mutex via Map<projectId, Promise> serializes seed/install
 *   for the same project; different projects run in parallel. inspect is
 *   lock-free (no writes).
 *
 * Events:
 *   Emits `harness.changed` ONLY when state on disk actually changed
 *   (seed wrote bytes, seedIfMissing filled a missing slot, or seed_failed).
 *   inspect never emits.
 *
 * Event-driven bootstrap:
 *   Subscribes to `project.registered` at construction; on receipt, invokes
 *   `seedIfMissing(projectId, 'harness-init')` fire-and-forget. Failures
 *   are swallowed (logged + stub-recorded) so register stays 201.
 */

import fs from "node:fs";
import path from "node:path";

import {
  AstackError,
  ErrorCode,
  EventType,
  HARNESS_SCAFFOLD_FILES,
  HarnessStatus,
  type HarnessStatus as HarnessStatusT,
  type Id,
  type ProjectHarnessScaffoldState,
  type ProjectHarnessState,
  type SystemSkill
} from "@astack/shared";

import type { EventBus } from "../events.js";
import {
  copyDirContents,
  hashDir,
  isDir,
  removeDir,
  writeFileAtomic
} from "../fs-util.js";
import type { Logger } from "../logger.js";
import type { ProjectService } from "../services/project.js";
import { systemSkillsRoot } from "./paths.js";
import { SYSTEM_SKILLS } from "./registry.js";

// ---------- Types ----------

export interface SystemSkillServiceDeps {
  events: EventBus;
  logger: Logger;
  projects: ProjectService;
}

/**
 * On-disk stub at `<project>/.astack/system-skills.json`.
 *
 * Records what was seeded, when, and the built-in hash AT SEED TIME.
 * Used by:
 *   - inspect() to detect seed_failed (last_error field)
 *   - v0.5 "built-in updated, Re-install" prompts (compare stub hash vs current built-in)
 */
interface StubSeededEntry {
  seeded_at: string;
  built_in_hash: string;
  source_path: string;
  last_error: string | null;
}

interface StubData {
  version: 1;
  seeded: Record<string, StubSeededEntry>;
}

// ---------- Constants ----------

const STUB_VERSION = 1;
const STUB_REL_PATH = ".astack/system-skills.json";

/**
 * Seed path for a given skill inside a project.
 * v0.4 hardcodes `<primary_tool>/skills/<id>/` — primary_tool != '.claude'
 * projects are skipped upstream (subscriber checks before dispatching).
 */
function seedDirFor(projectPath: string, primaryTool: string, skillId: string): string {
  return path.join(projectPath, primaryTool, "skills", skillId);
}

function stubPathFor(projectPath: string): string {
  return path.join(projectPath, STUB_REL_PATH);
}

// ---------- Service ----------

export class SystemSkillService {
  /** id → SystemSkill with precomputed content_hash (from systemSkillsRoot). */
  private readonly registry: Map<string, SystemSkill>;

  /** Per-project mutex: serialize seed/install on the same project. */
  private readonly projectMutex = new Map<Id, Promise<unknown>>();

  constructor(private readonly deps: SystemSkillServiceDeps) {
    this.registry = this.loadRegistry();

    // Event-driven auto-seed on project registration.
    this.deps.events.subscribe(({ event }) => {
      if (event.type !== EventType.ProjectRegistered) return;
      const project = event.payload.project;
      if (project.primary_tool !== ".claude") {
        this.deps.logger.debug("harness.skip_non_claude", {
          project_id: project.id,
          primary_tool: project.primary_tool
        });
        return;
      }
      // Fire-and-forget. seedIfMissing handles its own errors +
      // writeStubLastError + event emission.
      this.seedIfMissing(project.id, "harness-init").catch((err) => {
        // If even the outer catch path throws (unlikely), ensure logger
        // call itself can't escape. safeLog swallows logger errors so
        // we don't bubble unhandledRejection into the daemon.
        safeLog(this.deps.logger, "harness.subscriber_crash", {
          project_id: project.id,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    });
  }

  // ---------- Public API ----------

  /** Enumerate known system skills. v0.4: returns [harness-init]. */
  list(): SystemSkill[] {
    return [...this.registry.values()];
  }

  get(id: string): SystemSkill | null {
    return this.registry.get(id) ?? null;
  }

  /** Force-seed: overwrite whatever is at the target dir. */
  async seed(projectId: Id, skillId: string): Promise<ProjectHarnessState> {
    return this.withProjectMutex(projectId, async () => {
      const { project, skill } = this.resolveProjectAndSkill(projectId, skillId);
      try {
        this.writeSeedDir(project.path, project.primary_tool, skill);
        this.updateStubSeeded(project.path, skill);
      } catch (err) {
        return this.handleSeedFailure(project, skill, err);
      }
      // Seed wrote the skill dir, but the scaffold files (AGENTS.md +
      // docs/**) are still materialized by `/init_harness` in the AI
      // chat — not by writeSeedDir. Re-compute state so a seed into a
      // project with no governance docs correctly reports
      // `scaffold_incomplete` rather than a false-positive `installed`.
      const state = this.inspectNoLock(project, skill);
      this.emitChanged(projectId, skill.id, state.status);
      return state;
    });
  }

  /** Seed only when the target dir is absent. Used by register subscriber. */
  async seedIfMissing(
    projectId: Id,
    skillId: string
  ): Promise<ProjectHarnessState> {
    return this.withProjectMutex(projectId, async () => {
      const { project, skill } = this.resolveProjectAndSkill(projectId, skillId);
      const dir = seedDirFor(project.path, project.primary_tool, skill.id);
      if (fs.existsSync(dir)) {
        // Target exists — preserve whatever is there (legacy / user-managed).
        // State depends on actual contents; compute without writing.
        return this.inspectNoLock(project, skill);
      }
      try {
        this.writeSeedDir(project.path, project.primary_tool, skill);
        this.updateStubSeeded(project.path, skill);
      } catch (err) {
        return this.handleSeedFailure(project, skill, err);
      }
      // Fresh seed done; scaffold still likely missing on an
      // uninitialized project. Let inspectNoLock make the final call.
      const state = this.inspectNoLock(project, skill);
      this.emitChanged(projectId, skill.id, state.status);
      return state;
    });
  }

  /** Pure read — no fs writes, no events, no db changes. */
  async inspect(
    projectId: Id,
    skillId: string
  ): Promise<ProjectHarnessState> {
    const { project, skill } = this.resolveProjectAndSkill(projectId, skillId);
    return this.inspectNoLock(project, skill);
  }

  // ---------- Internals ----------

  private inspectNoLock(
    project: { id: Id; path: string; primary_tool: string },
    skill: SystemSkill
  ): ProjectHarnessState {
    const stub = this.readStub(project.path);
    const seededEntry = stub?.seeded[skill.id] ?? null;
    // Scaffold probe is always computed — every branch needs it on the
    // wire so the client can render the missing-files list even in
    // skill-level error states.
    const scaffold = computeScaffoldState(project.path);

    if (seededEntry?.last_error) {
      return this.buildState(project, skill, HarnessStatus.SeedFailed, {
        seededAt: seededEntry.seeded_at,
        stubHash: seededEntry.built_in_hash,
        lastError: seededEntry.last_error,
        scaffold
      });
    }

    const dir = seedDirFor(project.path, project.primary_tool, skill.id);
    if (!isDir(dir)) {
      return this.buildState(project, skill, HarnessStatus.Missing, {
        seededAt: seededEntry?.seeded_at ?? null,
        stubHash: seededEntry?.built_in_hash ?? null,
        scaffold
      });
    }

    const actualHash = hashDir(dir);
    const builtInHash = skill.content_hash;
    if (actualHash !== builtInHash) {
      return this.buildState(project, skill, HarnessStatus.Drift, {
        seededAt: seededEntry?.seeded_at ?? null,
        stubHash: seededEntry?.built_in_hash ?? null,
        actualHash,
        scaffold
      });
    }

    // Skill-level is clean. Now decide between installed and
    // scaffold_incomplete based on whether /init_harness has actually
    // been run.
    if (!scaffold.complete) {
      return this.buildState(project, skill, HarnessStatus.ScaffoldIncomplete, {
        seededAt: seededEntry?.seeded_at ?? null,
        stubHash: seededEntry?.built_in_hash ?? null,
        scaffold
      });
    }

    return this.buildState(project, skill, HarnessStatus.Installed, {
      seededAt: seededEntry?.seeded_at ?? null,
      stubHash: seededEntry?.built_in_hash ?? null,
      scaffold
    });
  }

  private resolveProjectAndSkill(
    projectId: Id,
    skillId: string
  ): { project: { id: Id; path: string; primary_tool: string }; skill: SystemSkill } {
    const project = this.deps.projects.mustFindById(projectId);
    const skill = this.registry.get(skillId);
    if (!skill) {
      throw new AstackError(
        ErrorCode.SKILL_NOT_FOUND,
        `unknown system skill: ${skillId}`,
        { skill_id: skillId }
      );
    }
    return { project, skill };
  }

  /** rmIfExists + copy (atomic-ish: best-effort for a single-user local tool). */
  private writeSeedDir(
    projectPath: string,
    primaryTool: string,
    skill: SystemSkill
  ): void {
    const dir = seedDirFor(projectPath, primaryTool, skill.id);
    // Ensure parent exists.
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    // Clean target first so stale files don't linger.
    if (fs.existsSync(dir)) {
      removeDir(dir);
    }
    copyDirContents(skill.source_path, dir);
  }

  private updateStubSeeded(projectPath: string, skill: SystemSkill): void {
    const existing = this.readStub(projectPath) ?? {
      version: STUB_VERSION,
      seeded: {}
    };
    const next: StubData = {
      version: STUB_VERSION,
      seeded: {
        ...existing.seeded,
        [skill.id]: {
          seeded_at: new Date().toISOString(),
          built_in_hash: skill.content_hash,
          source_path: skill.source_path,
          last_error: null
        }
      }
    };
    this.writeStub(projectPath, next);
  }

  private writeStubLastError(projectPath: string, skillId: string, message: string): void {
    try {
      const existing = this.readStub(projectPath) ?? {
        version: STUB_VERSION,
        seeded: {}
      };
      const prev = existing.seeded[skillId];
      const next: StubData = {
        version: STUB_VERSION,
        seeded: {
          ...existing.seeded,
          [skillId]: {
            seeded_at: prev?.seeded_at ?? new Date().toISOString(),
            built_in_hash: prev?.built_in_hash ?? "",
            source_path: prev?.source_path ?? "",
            last_error: message
          }
        }
      };
      this.writeStub(projectPath, next);
    } catch (err) {
      // Writing the error record itself failed — log and move on.
      safeLog(this.deps.logger, "harness.stub_last_error_write_failed", {
        project_path: projectPath,
        skill_id: skillId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private handleSeedFailure(
    project: { id: Id; path: string; primary_tool: string },
    skill: SystemSkill,
    err: unknown
  ): ProjectHarnessState {
    const msg = err instanceof Error ? err.message : String(err);
    safeLog(this.deps.logger, "harness.seed_failed", {
      project_id: project.id,
      skill_id: skill.id,
      error: msg
    });
    this.writeStubLastError(project.path, skill.id, msg);
    this.emitChanged(project.id, skill.id, HarnessStatus.SeedFailed, msg);
    return this.buildState(project, skill, HarnessStatus.SeedFailed, {
      lastError: msg,
      scaffold: computeScaffoldState(project.path)
    });
  }

  private emitChanged(
    projectId: Id,
    skillId: string,
    status: HarnessStatusT,
    lastError?: string
  ): void {
    try {
      this.deps.events.emit({
        type: EventType.HarnessChanged,
        payload: {
          project_id: projectId,
          skill_id: skillId,
          status,
          seeded_at: new Date().toISOString(),
          last_error: lastError ?? null
        }
      });
    } catch (err) {
      safeLog(this.deps.logger, "harness.emit_failed", {
        project_id: projectId,
        skill_id: skillId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private buildState(
    project: { id: Id; path: string; primary_tool: string },
    skill: SystemSkill,
    status: HarnessStatusT,
    extras: {
      seededAt?: string | null;
      stubHash?: string | null;
      actualHash?: string | null;
      lastError?: string | null;
      scaffold?: ProjectHarnessScaffoldState;
    } = {}
  ): ProjectHarnessState {
    return {
      project_id: project.id,
      skill,
      status,
      seeded_at: extras.seededAt ?? null,
      stub_built_in_hash: extras.stubHash ?? null,
      actual_hash: extras.actualHash ?? null,
      last_error: extras.lastError ?? null,
      scaffold: extras.scaffold ?? emptyScaffoldState()
    };
  }

  // ---------- Stub i/o ----------

  readStub(projectPath: string): StubData | null {
    const p = stubPathFor(projectPath);
    try {
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as StubData;
      // Best-effort validation; if future versions add fields, just accept.
      if (typeof parsed !== "object" || parsed === null) return null;
      if (typeof parsed.version !== "number") return null;
      if (typeof parsed.seeded !== "object" || parsed.seeded === null) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private writeStub(projectPath: string, data: StubData): void {
    const p = stubPathFor(projectPath);
    writeFileAtomic(p, JSON.stringify(data, null, 2));
  }

  // ---------- Registry loader ----------

  private loadRegistry(): Map<string, SystemSkill> {
    const root = systemSkillsRoot();
    const map = new Map<string, SystemSkill>();
    for (const entry of SYSTEM_SKILLS) {
      const source = path.join(root, entry.id);
      const content_hash = hashDir(source);
      if (!content_hash) {
        // Directory missing / unreadable at startup — fatal for this skill
        // but we don't crash the daemon; just skip and log. Without a
        // content_hash, drift detection is impossible anyway.
        safeLog(this.deps.logger, "harness.registry_load_failed", {
          skill_id: entry.id,
          source
        });
        continue;
      }
      map.set(entry.id, {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        source_path: source,
        content_hash
      });
    }
    return map;
  }

  // ---------- Mutex ----------

  private async withProjectMutex<T>(
    projectId: Id,
    fn: () => Promise<T>
  ): Promise<T> {
    const prev = this.projectMutex.get(projectId) ?? Promise.resolve();
    // Chain the new op after any in-flight one; suppress predecessor errors
    // so one failure doesn't cascade.
    const next = prev.catch(() => undefined).then(fn);
    this.projectMutex.set(projectId, next);
    try {
      return await next;
    } finally {
      // Clean up when we're the last one in line (best-effort).
      if (this.projectMutex.get(projectId) === next) {
        this.projectMutex.delete(projectId);
      }
    }
  }
}

// ---------- Helpers ----------

/**
 * Logger wrapper that cannot itself throw. A broken logger (rare: close on
 * stderr, full disk) would otherwise produce unhandledRejection inside
 * fire-and-forget paths. See v0.4 spec §A4 Issue 1.
 */
export function safeLog(
  logger: Logger,
  event: string,
  fields?: Record<string, unknown>
): void {
  try {
    logger.warn(event, fields);
  } catch {
    // swallow
  }
}

/**
 * Probe whether the governance scaffold files required by Harness exist
 * under the project root. The list lives in `@astack/shared`
 * (`HARNESS_SCAFFOLD_FILES`) so server and web agree on what "complete"
 * means. Missing files are returned as POSIX-relative paths, in the same
 * order as `HARNESS_SCAFFOLD_FILES`.
 *
 * This function is pure (no writes, no throws for missing files). An
 * inaccessible path just looks "missing" — the next `/init_harness` run
 * will materialize it.
 */
export function computeScaffoldState(projectPath: string): ProjectHarnessScaffoldState {
  const files = [...HARNESS_SCAFFOLD_FILES];
  const missing = files.filter((rel) => {
    const abs = path.join(projectPath, rel);
    try {
      return !fs.existsSync(abs) || !fs.statSync(abs).isFile();
    } catch {
      return true;
    }
  });
  return {
    files,
    missing,
    complete: missing.length === 0
  };
}

function emptyScaffoldState(): ProjectHarnessScaffoldState {
  const files = [...HARNESS_SCAFFOLD_FILES];
  return { files, missing: files, complete: false };
}
