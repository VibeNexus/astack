/**
 * /api/fs routes — read-only filesystem navigation for the dashboard's
 * path autocomplete.
 *
 * Scope: only `GET /api/fs/list`. No writes, no file contents, directory
 * listings only. See packages/shared/src/schemas/fs.ts for the safety
 * model discussion.
 *
 * Runs with the daemon's own uid, so what it can list == what the user
 * can list. If `readdir` throws EACCES / ENOENT / ENOTDIR we swallow the
 * error and return an empty listing with `exists: false` — the UI stays
 * responsive, the user gets immediate feedback ("that path doesn't work")
 * without the API surface exploding with 500s.
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  FsEntryKind,
  FsListQuerySchema,
  type FsEntry,
  type FsListResponse
} from "@astack/shared";
import { Hono } from "hono";

import { zValidator } from "./validator.js";
import type { ServiceContainer } from "./container.js";

/**
 * Expand `~` / `~/` prefixes to the current user's home directory.
 * Everything else is returned unchanged. We do this so users can paste
 * `~/code` and have it resolve sensibly even though the daemon process
 * doesn't itself do shell expansion.
 */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Normalize a user-supplied path into a canonical absolute one.
 *
 * Returns null if the input cannot become absolute (e.g. "foo/bar" with
 * no leading slash and no `~`). The caller treats null as "bad path".
 */
function normalizeAbsolute(raw: string | undefined): string | null {
  if (!raw || raw.trim() === "") return os.homedir();
  const expanded = expandHome(raw.trim());
  if (!path.isAbsolute(expanded)) return null;
  // path.resolve collapses `..`, duplicate slashes, trailing slash.
  return path.resolve(expanded);
}

export function fsRoutes(_c: ServiceContainer): Hono {
  const app = new Hono();

  app.get("/list", zValidator("query", FsListQuerySchema), async (ctx) => {
    const { path: rawPath, show_hidden } = ctx.req.valid("query");
    const absPath = normalizeAbsolute(rawPath);

    if (absPath === null) {
      // Bad input; degrade to "empty result" rather than error so the
      // autocomplete UI just shows "no matches" while the user keeps typing.
      const fallback = os.homedir();
      const response: FsListResponse = {
        path: fallback,
        parent: null,
        exists: false,
        entries: []
      };
      return ctx.json(response);
    }

    const showHidden = show_hidden === "1" || show_hidden === "true";
    const parent = path.dirname(absPath);
    // path.dirname("/") returns "/". Distinguish root so the UI can
    // disable the "up" affordance.
    const parentForResponse = absPath === parent ? null : parent;

    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fsp.readdir(absPath, { withFileTypes: true });
    } catch {
      const response: FsListResponse = {
        path: absPath,
        parent: parentForResponse,
        exists: false,
        entries: []
      };
      return ctx.json(response);
    }

    const entries: FsEntry[] = [];
    for (const d of dirents) {
      const name = d.name;
      const hidden = name.startsWith(".");
      if (hidden && !showHidden) continue;

      // Resolve symlink kind best-effort. If stat fails (dangling link,
      // permission denied), skip the entry — better than lying about its
      // kind.
      let kind: FsEntry["kind"];
      if (d.isDirectory()) {
        kind = FsEntryKind.Dir;
      } else if (d.isFile()) {
        kind = FsEntryKind.File;
      } else if (d.isSymbolicLink()) {
        try {
          const s = await fsp.stat(path.join(absPath, name));
          kind = s.isDirectory() ? FsEntryKind.Dir : FsEntryKind.File;
        } catch {
          continue;
        }
      } else {
        // Sockets, block devices, etc. — not useful here.
        continue;
      }

      entries.push({
        name,
        path: path.join(absPath, name),
        kind,
        hidden
      });
    }

    // Sort: dirs first (they're the navigable targets), then files, each
    // group alphabetical. Locale-aware compare so accented names don't
    // cluster weirdly.
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === FsEntryKind.Dir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const response: FsListResponse = {
      path: absPath,
      parent: parentForResponse,
      exists: true,
      entries
    };
    return ctx.json(response);
  });

  return app;
}
