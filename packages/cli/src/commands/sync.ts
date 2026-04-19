/**
 * `astack sync` — pull all subscriptions (or --only <ids>).
 */

import { AstackClient } from "../client.js";
import { loadProjectContext } from "../context.js";
import { ensureDaemonOnline } from "../daemon-check.js";
import { printNext, printOk, printWarn } from "../output.js";

export interface SyncOptions {
  force?: boolean;
  skillIds?: number[];
}

export async function runSync(opts: SyncOptions = {}): Promise<void> {
  const ctx = loadProjectContext();
  const client = new AstackClient({ baseUrl: ctx.serverUrl });
  await ensureDaemonOnline(client);

  const result = await client.sync(ctx.projectId, {
    force: opts.force ?? false,
    skill_ids: opts.skillIds
  });

  const total =
    result.synced + result.up_to_date + result.conflicts + result.errors;
  if (total === 0) {
    printWarn("no subscriptions to sync — run 'astack subscribe <skill>' first");
    return;
  }

  if (result.synced > 0) printOk(`synced ${result.synced} skill(s)`);
  if (result.up_to_date > 0) printOk(`${result.up_to_date} already up-to-date`);
  if (result.conflicts > 0) {
    printWarn(`${result.conflicts} conflict(s) detected`);
    for (const o of result.outcomes) {
      if (o.log.status === "conflict") {
        printNext(
          `resolve: astack resolve ${o.skill.name} --use-remote | --keep-local | --manual`
        );
      }
    }
  }
  if (result.errors > 0) printWarn(`${result.errors} error(s)`);
}
