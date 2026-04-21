/**
 * `astack link <add|remove|list> ...` — tool symlink management.
 */

import kleur from "kleur";

import { AstackClient } from "../client.js";
import { loadProjectContext } from "../context.js";
import { ensureDaemonOnline } from "../daemon-check.js";
import { printNext, printOk, printTable, printWarn } from "../output.js";

export async function runLinkAdd(
  toolName: string,
  dirName?: string
): Promise<void> {
  const ctx = loadProjectContext();
  const client = new AstackClient({ baseUrl: ctx.serverUrl });
  await ensureDaemonOnline(client);

  const result = await client.createLinkedDir(ctx.projectId, {
    tool_name: toolName,
    dir_name: dirName
  });
  printOk(
    `linked ${result.link.tool_name} → ${ctx.primaryTool} (${result.link.dir_name})`
  );
}

export async function runLinkRemove(toolName: string): Promise<void> {
  const ctx = loadProjectContext();
  const client = new AstackClient({ baseUrl: ctx.serverUrl });
  await ensureDaemonOnline(client);

  await client.deleteLinkedDir(ctx.projectId, toolName);
  printOk(`removed link: ${toolName}`);
}

export async function runLinkList(): Promise<void> {
  const ctx = loadProjectContext();
  const client = new AstackClient({ baseUrl: ctx.serverUrl });
  await ensureDaemonOnline(client);

  const status = await client.projectStatus(ctx.projectId);
  if (status.linked_dirs.length === 0) {
    printWarn("no linked dirs configured");
    printNext("add one with: astack link add <tool_name>");
    return;
  }

  const rows: string[][] = [[kleur.bold("tool"), kleur.bold("dir"), kleur.bold("status")]];
  for (const link of status.linked_dirs) {
    rows.push([link.tool_name, link.dir_name, colorStatus(link.status)]);
  }
  printTable(rows);
}

function colorStatus(status: string): string {
  switch (status) {
    case "active":
      return kleur.green(status);
    case "broken":
      return kleur.yellow(status);
    case "removed":
      return kleur.gray(status);
    default:
      return status;
  }
}
