/**
 * Helpers for building git fixture repos in tests.
 *
 * Strategy per design.md test decision 10: use `tmp-promise` to create
 * real bare repos and client clones — do NOT mock git.
 *
 * Uses child_process for `git init --bare` because simple-git's `.init()`
 * in some versions ignores its baseDir when the dir is empty on macOS,
 * polluting CWD instead. `execFile` with explicit `cwd` is unambiguous.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { simpleGit } from "simple-git";
import tmp from "tmp-promise";

const execFileAsync = promisify(execFile);

const AUTHOR = { name: "Test", email: "test@example.com" };

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

/**
 * Initialize a bare git repo (used as a "remote") at `dir/bare.git` and
 * return a helper to commit files into it via a hidden working checkout.
 */
export async function createBareRepo(): Promise<BareRepoHandle> {
  const dir = await tmp.dir({ unsafeCleanup: true });
  const bareDir = path.join(dir.path, "bare.git");
  const workDir = path.join(dir.path, "work");

  fs.mkdirSync(bareDir, { recursive: true });
  await runGit(bareDir, ["init", "--bare", "--initial-branch=main"]);

  fs.mkdirSync(workDir, { recursive: true });
  await runGit(dir.path, ["clone", bareDir, workDir]);

  const work = simpleGit(workDir);
  await work.addConfig("user.name", AUTHOR.name);
  await work.addConfig("user.email", AUTHOR.email);

  return {
    dir,
    bareDir,
    workDir,
    url: bareDir,
    async addFile(relPath: string, contents: string): Promise<void> {
      const full = path.join(workDir, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, contents);
      await work.add(relPath);
    },
    async commit(message: string): Promise<string> {
      const result = await work.commit(message);
      return result.commit;
    },
    async push(): Promise<void> {
      await work.push("origin", "main");
    },
    async addCommitPush(
      relPath: string,
      contents: string,
      message: string
    ): Promise<string> {
      await this.addFile(relPath, contents);
      const hash = await this.commit(message);
      await this.push();
      return hash;
    }
  };
}

export interface BareRepoHandle {
  dir: tmp.DirectoryResult;
  bareDir: string;
  workDir: string;
  url: string;
  addFile(relPath: string, contents: string): Promise<void>;
  commit(message: string): Promise<string>;
  push(): Promise<void>;
  addCommitPush(
    relPath: string,
    contents: string,
    message: string
  ): Promise<string>;
}
