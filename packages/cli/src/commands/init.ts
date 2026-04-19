/**
 * `astack init` — register the current directory as an astack project.
 *
 * Creates the .claude/ primary tool dir if missing (so subsequent sync
 * has somewhere to write). The server's register endpoint handles the
 * DB row; we persist the returned project_id to .claude/.astack.json
 * via a no-op subscribe reconcile dance — or rather, the server itself
 * writes the manifest on first subscribe. To make `init` end-to-end
 * useful before any subscribe, we write a minimal manifest stub here.
 */

import fs from "node:fs";
import path from "node:path";

import { AstackError, ErrorCode } from "@astack/shared";

import { AstackClient } from "../client.js";
import { DEFAULT_DAEMON_URL, loadProjectContext } from "../context.js";
import { ensureDaemonOnline } from "../daemon-check.js";
import { printNext, printOk, printWarn } from "../output.js";

export interface InitOptions {
  /** Override project name (default = basename of cwd). */
  name?: string;
  /** Primary tool dir (default ".claude"). */
  primaryTool?: string;
  /** Daemon URL override. */
  daemonUrl?: string;
}

export async function runInit(opts: InitOptions = {}): Promise<void> {
  const rootPath = process.cwd();
  const baseUrl = opts.daemonUrl ?? DEFAULT_DAEMON_URL;

  // If already initialized, short-circuit with a friendly message.
  try {
    const existing = loadProjectContext(rootPath);
    if (existing.rootPath === rootPath) {
      printWarn(`project already initialized (project_id=${existing.projectId})`);
      return;
    }
  } catch (err) {
    if (!(err instanceof AstackError) || err.code !== ErrorCode.PROJECT_NOT_FOUND) {
      throw err;
    }
  }

  const client = new AstackClient({ baseUrl });
  await ensureDaemonOnline(client);

  const primaryTool = opts.primaryTool ?? ".claude";
  const name = opts.name ?? path.basename(rootPath);

  const { project } = await client.registerProject({
    path: rootPath,
    name,
    primary_tool: primaryTool
  });

  // Write a minimal manifest stub so later commands can locate the project.
  const manifestPath = path.join(rootPath, primaryTool, ".astack.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          project_id: project.id,
          server_url: baseUrl,
          primary_tool: primaryTool,
          linked_tools: [],
          subscriptions: [],
          last_synced: null
        },
        null,
        2
      ) + "\n"
    );
  }

  printOk(`registered project: ${project.name} (id=${project.id})`);
  printNext(`Dashboard: ${baseUrl}`);
  printNext(`Next: astack subscribe <skill>`);
}
