/**
 * `astack status` — show all subscriptions + per-skill sync state.
 */

import { SubscriptionState } from "@astack/shared";
import kleur from "kleur";

import { AstackClient } from "../client.js";
import { loadProjectContext } from "../context.js";
import { ensureDaemonOnline } from "../daemon-check.js";
import { printInfo, printNext, printTable, sym } from "../output.js";

export async function runStatus(): Promise<void> {
  const ctx = loadProjectContext();
  const client = new AstackClient({ baseUrl: ctx.serverUrl });
  await ensureDaemonOnline(client);

  const status = await client.projectStatus(ctx.projectId);

  printInfo(
    `${kleur.bold(status.project.name)}  ${kleur.gray(`(id=${status.project.id})`)}  ${kleur.gray(status.project.path)}`
  );
  if (status.last_synced) {
    printInfo(`last synced: ${status.last_synced}`);
  }

  if (status.subscriptions.length === 0) {
    printNext("no subscriptions yet. Try: astack subscribe <skill>");
    return;
  }

  const rows: string[][] = [];
  rows.push([
    kleur.bold("state"),
    kleur.bold("skill"),
    kleur.bold("repo"),
    kleur.bold("version"),
    kleur.bold("detail")
  ]);
  for (const sub of status.subscriptions) {
    rows.push([
      renderState(sub.state),
      `${sub.skill.type === "skill" ? kleur.magenta("[skill] ") : ""}${sub.skill.name}`,
      kleur.gray(sub.repo.name),
      kleur.gray(sub.skill.version?.slice(0, 7) ?? "—"),
      kleur.gray(sub.state_detail ?? "")
    ]);
  }
  printTable(rows);

  if (status.tool_links.length > 0) {
    printNext(
      `tools linked: ${status.tool_links.map((l) => l.tool_name).join(", ")}`
    );
  }
}

function renderState(state: string): string {
  switch (state) {
    case SubscriptionState.Synced:
      return kleur.green(`${sym.ok}  synced`);
    case SubscriptionState.Behind:
      return kleur.yellow(`${sym.behind}  behind`);
    case SubscriptionState.LocalAhead:
      return kleur.cyan(`${sym.ahead}  local-ahead`);
    case SubscriptionState.Conflict:
      return kleur.red(`${sym.warn}  conflict`);
    case SubscriptionState.Pending:
      return kleur.gray(`${sym.dot}  pending`);
    default:
      return state;
  }
}
