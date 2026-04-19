/**
 * `astack push [<skill>...]` — push local changes back to upstream.
 */

import { AstackError, ErrorCode, SubscriptionState } from "@astack/shared";

import { AstackClient } from "../client.js";
import { loadProjectContext } from "../context.js";
import { ensureDaemonOnline } from "../daemon-check.js";
import { printNext, printOk, printWarn } from "../output.js";

export interface PushOptions {
  commitMessage?: string;
}

export async function runPush(
  refs: string[],
  opts: PushOptions = {}
): Promise<void> {
  const ctx = loadProjectContext();
  const client = new AstackClient({ baseUrl: ctx.serverUrl });
  await ensureDaemonOnline(client);

  let skillIds: number[] | undefined;
  if (refs.length > 0) {
    const status = await client.projectStatus(ctx.projectId);
    const byName = new Map<string, number>();
    for (const sub of status.subscriptions) {
      byName.set(sub.skill.name, sub.skill.id);
    }
    skillIds = [];
    for (const ref of refs) {
      const id = byName.get(ref);
      if (!id) {
        throw new AstackError(
          ErrorCode.SKILL_NOT_FOUND,
          `skill '${ref}' is not a current subscription`,
          { name: ref }
        );
      }
      skillIds.push(id);
    }
  }

  const result = await client.push(ctx.projectId, {
    skill_ids: skillIds,
    commit_message: opts.commitMessage
  });

  if (result.pushed > 0) printOk(`pushed ${result.pushed} skill(s)`);
  if (result.no_changes > 0) printWarn(`${result.no_changes} had no local changes`);
  if (result.readonly_skipped > 0) {
    printWarn(
      `${result.readonly_skipped} skipped (open-source repo, pull-only)`
    );
  }
  if (result.conflicts > 0) {
    printWarn(`${result.conflicts} conflict(s) — run 'astack status' to see details`);
    for (const o of result.outcomes) {
      if (o.state === SubscriptionState.Conflict) {
        printNext(
          `resolve: astack resolve ${o.skill.name} --use-remote | --keep-local | --manual`
        );
      }
    }
  }
  if (result.errors > 0) printWarn(`${result.errors} error(s)`);
}
