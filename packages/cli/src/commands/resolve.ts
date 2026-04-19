/**
 * `astack resolve <skill> [--use-remote | --keep-local | --manual [--done]]`
 */

import {
  AstackError,
  ErrorCode,
  ResolveStrategy,
  type ResolveStrategy as ResolveStrategyT
} from "@astack/shared";

import { AstackClient } from "../client.js";
import { loadProjectContext } from "../context.js";
import { ensureDaemonOnline } from "../daemon-check.js";
import { printOk } from "../output.js";

export interface ResolveOptions {
  strategy: ResolveStrategyT;
  manualDone?: boolean;
}

export async function runResolve(
  ref: string,
  opts: ResolveOptions
): Promise<void> {
  const ctx = loadProjectContext();
  const client = new AstackClient({ baseUrl: ctx.serverUrl });
  await ensureDaemonOnline(client);

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

  const result = await client.resolve(ctx.projectId, {
    skill_id: sub.skill.id,
    strategy: opts.strategy,
    manual_done: opts.manualDone ?? false
  });

  printOk(
    `resolved ${sub.skill.name} via ${opts.strategy} (new version: ${
      result.log.to_version?.slice(0, 7) ?? "—"
    })`
  );

  // Guard: unused export warning on ResolveStrategy.
  void ResolveStrategy;
}
