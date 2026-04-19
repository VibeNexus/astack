/**
 * `astack subscribe <skill> [<skill>...]` — subscribe to meta-skills.
 */

import { SkillType, type SkillType as SkillTypeT } from "@astack/shared";

import { AstackClient } from "../client.js";
import { loadProjectContext } from "../context.js";
import { ensureDaemonOnline } from "../daemon-check.js";
import { printNext, printOk, printWarn } from "../output.js";

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

  printOk(`subscribed ${result.subscriptions.length} skill(s)`);
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

  // Silence unused SkillType import warning in consumers that don't use enum.
  void SkillType;
}
