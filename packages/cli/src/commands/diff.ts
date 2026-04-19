/**
 * `astack diff <skill>` — show whether a skill's working copy differs
 * from upstream (currently reports identical / not; unified diff text
 * is a v1 followup — server-side we'd need a shell-out to `git diff`).
 */

import { AstackError, ErrorCode } from "@astack/shared";
import kleur from "kleur";

import { AstackClient } from "../client.js";
import { loadProjectContext } from "../context.js";
import { ensureDaemonOnline } from "../daemon-check.js";
import { print, printNext, printOk, printWarn } from "../output.js";

export async function runDiff(ref: string): Promise<void> {
  const ctx = loadProjectContext();
  const client = new AstackClient({ baseUrl: ctx.serverUrl });
  await ensureDaemonOnline(client);

  // Resolve skill name → id via project status.
  const status = await client.projectStatus(ctx.projectId);
  const sub = status.subscriptions.find(
    (s) => s.skill.name === ref || String(s.skill.id) === ref
  );
  if (!sub) {
    throw new AstackError(
      ErrorCode.SKILL_NOT_FOUND,
      `skill '${ref}' is not a subscription of this project`,
      { ref }
    );
  }

  const diff = await client.skillDiff(ctx.projectId, sub.skill.id);
  if (diff.identical) {
    printOk(`${sub.skill.name}: working copy matches upstream`);
    return;
  }

  printWarn(`${sub.skill.name}: local differs from upstream`);
  print(
    `  ${kleur.gray("upstream:")} ${diff.upstream_version?.slice(0, 7) ?? "—"}`
  );
  print(
    `  ${kleur.gray("working: ")} ${diff.working_version?.slice(0, 7) ?? "—"}`
  );
  printNext(
    `Unified diff view is not yet implemented in v1; compare files directly under ${ctx.primaryTool}/${sub.skill.path}`
  );
}
