/**
 * `astack subscribe <skill> [<skill>...]` — subscribe to meta-skills.
 */

import { SkillType, type SkillType as SkillTypeT } from "@astack/shared";

import { AstackClient } from "../client.js";
import { loadProjectContext } from "../context.js";
import { ensureDaemonOnline } from "../daemon-check.js";
import { printErr, printNext, printOk, printWarn } from "../output.js";

export interface SubscribeOptions {
  type?: SkillTypeT;
  noSync?: boolean;
  pin?: string;
}

export async function runSubscribe(
  refs: string[],
  opts: SubscribeOptions = {}
): Promise<void> {
  if (refs.length === 0) {
    throw new Error("subscribe requires at least one skill ref");
  }

  const ctx = loadProjectContext();
  const client = new AstackClient({ baseUrl: ctx.serverUrl });
  await ensureDaemonOnline(client);

  const result = await client.subscribe(ctx.projectId, {
    skills: refs,
    type: opts.type,
    pinned_version: opts.pin,
    sync_now: !opts.noSync
  });

  if (result.subscriptions.length > 0) {
    printOk(`subscribed ${result.subscriptions.length} skill(s)`);
  }

  // v0.3: per-ref failures land in result.failures (HTTP stays 2xx on partial
  // success). Surface them individually so users see WHICH refs failed and
  // WHY, then exit 1 so shell scripts pick up the error reliably.
  if (result.failures && result.failures.length > 0) {
    for (const f of result.failures) {
      printErr(`✗ ${f.ref}: ${f.message} (${f.code})`);
    }
  }

  if (!opts.noSync) {
    const success = result.sync_logs.filter((l) => l.status === "success").length;
    const conflict = result.sync_logs.filter((l) => l.status === "conflict").length;
    const errored = result.sync_logs.filter((l) => l.status === "error").length;
    if (success > 0) printOk(`synced ${success} skill(s) to working copy`);
    if (conflict > 0) printWarn(`${conflict} conflict(s) — run 'astack status' for details`);
    if (errored > 0) printWarn(`${errored} error(s) during initial sync`);
  } else {
    printNext("Run 'astack sync' to materialize the working copy");
  }

  // Fail the command if ANY ref failed. The user saw the successful subs
  // printed above, so this isn't hiding work — just communicating that
  // the batch wasn't 100% clean.
  if (result.failures && result.failures.length > 0) {
    process.exitCode = 1;
  }

  // Silence unused SkillType import warning in consumers that don't use enum.
  void SkillType;
}
