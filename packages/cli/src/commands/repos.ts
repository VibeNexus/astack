/**
 * `astack repos <register|list|remove|refresh>` — bonus commands for
 * managing skill repos from the CLI. Dashboard does the same via Web.
 */

import type { RepoKind } from "@astack/shared";
import kleur from "kleur";

import { AstackClient } from "../client.js";
import { DEFAULT_DAEMON_URL } from "../context.js";
import { ensureDaemonOnline } from "../daemon-check.js";
import { printInfo, printOk, printTable, printWarn } from "../output.js";

export async function runReposRegister(
  gitUrl: string,
  opts: {
    name?: string;
    /** True → register as open-source (pull-only). Default custom. */
    readonly?: boolean;
    daemonUrl?: string;
  } = {}
): Promise<void> {
  const client = new AstackClient({
    baseUrl: opts.daemonUrl ?? DEFAULT_DAEMON_URL
  });
  await ensureDaemonOnline(client);

  const kind: RepoKind = opts.readonly ? "open-source" : "custom";
  const { repo, command_count, skill_count } = await client.registerRepo({
    git_url: gitUrl,
    name: opts.name,
    kind
  });
  const kindLabel =
    repo.kind === "open-source" ? kleur.yellow("[open-source, pull-only]") : "";
  printOk(
    `registered repo '${repo.name}' ${kindLabel} (${command_count} command(s), ${skill_count} skill(s))`.trim()
  );
}

export async function runReposList(
  opts: { daemonUrl?: string } = {}
): Promise<void> {
  const client = new AstackClient({
    baseUrl: opts.daemonUrl ?? DEFAULT_DAEMON_URL
  });
  await ensureDaemonOnline(client);

  const { repos, total } = await client.listRepos();
  if (total === 0) {
    printWarn("no repos registered");
    return;
  }
  printInfo(`${total} repo(s) registered`);
  const rows: string[][] = [
    [
      kleur.bold("id"),
      kleur.bold("name"),
      kleur.bold("kind"),
      kleur.bold("head"),
      kleur.bold("url")
    ]
  ];
  for (const r of repos) {
    const kindCell =
      r.kind === "open-source" ? kleur.yellow("read-only") : kleur.gray("custom");
    rows.push([
      String(r.id),
      r.name,
      kindCell,
      kleur.gray(r.head_hash?.slice(0, 7) ?? "—"),
      kleur.gray(r.git_url)
    ]);
  }
  printTable(rows);
}

export async function runReposRemove(
  id: number,
  opts: { daemonUrl?: string } = {}
): Promise<void> {
  const client = new AstackClient({
    baseUrl: opts.daemonUrl ?? DEFAULT_DAEMON_URL
  });
  await ensureDaemonOnline(client);

  await client.deleteRepo(id);
  printOk(`removed repo id=${id}`);
}

export async function runReposRefresh(
  id: number,
  opts: { daemonUrl?: string } = {}
): Promise<void> {
  const client = new AstackClient({
    baseUrl: opts.daemonUrl ?? DEFAULT_DAEMON_URL
  });
  await ensureDaemonOnline(client);

  const { changed, skills } = await client.refreshRepo(id);
  printOk(
    `refreshed repo id=${id} (${changed ? "HEAD moved" : "no changes"}; ${skills.length} skill(s))`
  );
}
