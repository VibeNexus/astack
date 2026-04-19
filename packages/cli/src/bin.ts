#!/usr/bin/env node
/**
 * @astack/cli — command-line interface for Astack.
 *
 * Commands (see docs/asset/design.md § CLI 核心工作流):
 *   astack init                         register current dir
 *   astack subscribe <skill>...         subscribe to skills
 *   astack sync [--force]               pull all subscriptions
 *   astack push [<skill>...]            push local changes
 *   astack status                       show per-skill sync state
 *   astack diff <skill>                 compare working vs upstream
 *   astack resolve <skill> --strategy   resolve a conflict
 *   astack link add|remove|list         manage tool symlinks
 *   astack server start|stop|status|logs  daemon lifecycle
 *   astack repos register|list|remove|refresh   manage skill repos
 */

import { AstackError, ResolveStrategy, SkillType } from "@astack/shared";
import { Command } from "commander";

import { runDiff } from "./commands/diff.js";
import { runInit } from "./commands/init.js";
import { runLinkAdd, runLinkList, runLinkRemove } from "./commands/link.js";
import { runPush } from "./commands/push.js";
import {
  runReposList,
  runReposRefresh,
  runReposRegister,
  runReposRemove
} from "./commands/repos.js";
import { runResolve } from "./commands/resolve.js";
import {
  runServerLogs,
  runServerStart,
  runServerStatus,
  runServerStop
} from "./commands/server.js";
import { runStatus } from "./commands/status.js";
import { runSubscribe } from "./commands/subscribe.js";
import { runSync } from "./commands/sync.js";
import { printErr } from "./output.js";

async function wrap(
  fn: () => Promise<void> | void,
  exitOnError = true
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof AstackError) {
      printErr(`${err.code}: ${err.message}`);
      if (err.details && Object.keys(err.details).length > 0) {
        process.stderr.write(
          "  " + JSON.stringify(err.details, null, 2).replace(/\n/g, "\n  ") + "\n"
        );
      }
    } else {
      printErr(err instanceof Error ? err.message : String(err));
    }
    if (exitOnError) process.exit(1);
  }
}

const program = new Command();
program
  .name("astack")
  .description("AI Harness System — manage Claude/Cursor/CodeBuddy skills across projects")
  .version("0.1.0");

// ---------- init ----------
program
  .command("init")
  .description("register the current directory as an astack project")
  .option("-n, --name <name>", "project name (default: basename of cwd)")
  .option("-t, --primary-tool <dir>", "primary tool dir name (default .claude)")
  .option("--daemon-url <url>", "override daemon URL")
  .action((opts) =>
    wrap(() =>
      runInit({
        name: opts.name,
        primaryTool: opts.primaryTool,
        daemonUrl: opts.daemonUrl
      })
    )
  );

// ---------- subscribe ----------
program
  .command("subscribe <skills...>")
  .description("subscribe to one or more meta-skills")
  .option("--type <type>", "disambiguate 'command' vs 'skill' when both exist")
  .option("--no-sync", "skip initial sync")
  .option("--pin <hash>", "pin to a specific commit hash (single skill only)")
  .action((skills: string[], opts) =>
    wrap(() =>
      runSubscribe(skills, {
        type:
          opts.type === SkillType.Command || opts.type === SkillType.Skill
            ? (opts.type as typeof SkillType.Command | typeof SkillType.Skill)
            : undefined,
        noSync: opts.sync === false,
        pin: opts.pin
      })
    )
  );

// ---------- sync ----------
program
  .command("sync")
  .description("pull latest version of subscribed skills to working copy")
  .option("-f, --force", "bypass TTL cache and fetch from remote", false)
  .action((opts) => wrap(() => runSync({ force: opts.force })));

// ---------- push ----------
program
  .command("push [skills...]")
  .description("push local skill edits back to upstream git repo")
  .option("-m, --message <msg>", "override commit message")
  .action((skills: string[], opts) =>
    wrap(() => runPush(skills, { commitMessage: opts.message }))
  );

// ---------- status ----------
program
  .command("status")
  .description("show per-skill sync state for the current project")
  .action(() => wrap(() => runStatus()));

// ---------- diff ----------
program
  .command("diff <skill>")
  .description("compare a skill's working copy against upstream")
  .action((skill: string) => wrap(() => runDiff(skill)));

// ---------- resolve ----------
program
  .command("resolve <skill>")
  .description("resolve a conflict on a skill")
  .option("--use-remote", "overwrite working copy with upstream")
  .option("--keep-local", "push local version to upstream")
  .option("--manual", "user has manually merged the file")
  .option("--done", "with --manual: signal manual merge complete")
  .action((skill: string, opts) => {
    const flags = [opts.useRemote, opts.keepLocal, opts.manual].filter(Boolean).length;
    if (flags !== 1) {
      printErr("resolve requires exactly one of --use-remote / --keep-local / --manual");
      process.exit(1);
    }
    const strategy = opts.useRemote
      ? ResolveStrategy.UseRemote
      : opts.keepLocal
        ? ResolveStrategy.KeepLocal
        : ResolveStrategy.Manual;
    return wrap(() =>
      runResolve(skill, { strategy, manualDone: Boolean(opts.done) })
    );
  });

// ---------- link ----------
const linkCmd = program.command("link").description("manage multi-tool symlinks");
linkCmd
  .command("add <tool>")
  .description("create symlinks from <tool>/commands|skills to .claude/")
  .option("--dir <dir>", "override dir name (default .<tool>)")
  .action((tool: string, opts) => wrap(() => runLinkAdd(tool, opts.dir)));
linkCmd
  .command("remove <tool>")
  .description("remove symlinks for a tool")
  .action((tool: string) => wrap(() => runLinkRemove(tool)));
linkCmd
  .command("list")
  .description("list configured tool links")
  .action(() => wrap(() => runLinkList()));

// ---------- server ----------
const serverCmd = program.command("server").description("daemon lifecycle");
serverCmd
  .command("start")
  .description("start the daemon in the foreground on 127.0.0.1:7432")
  .action(() => wrap(() => runServerStart(), false));
serverCmd
  .command("stop")
  .description("SIGTERM the running daemon")
  .action(() => wrap(() => runServerStop()));
serverCmd
  .command("status")
  .description("print daemon state")
  .action(() => wrap(() => runServerStatus()));
serverCmd
  .command("logs")
  .description("tail the daemon log")
  .option("-n, --lines <n>", "number of tail lines", "200")
  .action((opts) =>
    wrap(() => runServerLogs(parseInt(opts.lines, 10) || 200))
  );

// ---------- repos (bonus) ----------
const reposCmd = program.command("repos").description("manage skill repos");
reposCmd
  .command("register <git_url>")
  .description("register a new skill repo")
  .option("-n, --name <name>", "override repo name")
  .option(
    "--readonly",
    "register as an open-source repo (pull-only, no push)",
    false
  )
  .option("--daemon-url <url>", "override daemon URL")
  .action((url: string, opts) =>
    wrap(() =>
      runReposRegister(url, {
        name: opts.name,
        readonly: opts.readonly === true,
        daemonUrl: opts.daemonUrl
      })
    )
  );
reposCmd
  .command("list")
  .description("list registered repos")
  .option("--daemon-url <url>", "override daemon URL")
  .action((opts) => wrap(() => runReposList({ daemonUrl: opts.daemonUrl })));
reposCmd
  .command("remove <id>")
  .description("remove a repo by id")
  .option("--daemon-url <url>", "override daemon URL")
  .action((id: string, opts) =>
    wrap(() =>
      runReposRemove(parseInt(id, 10), { daemonUrl: opts.daemonUrl })
    )
  );
reposCmd
  .command("refresh <id>")
  .description("force pull + re-scan of a repo")
  .option("--daemon-url <url>", "override daemon URL")
  .action((id: string, opts) =>
    wrap(() =>
      runReposRefresh(parseInt(id, 10), { daemonUrl: opts.daemonUrl })
    )
  );

program.parseAsync(process.argv).catch((err) => {
  printErr(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
