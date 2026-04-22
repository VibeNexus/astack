/**
 * Hono app factory + service wiring.
 *
 * Creates the complete server: opens the SQLite database, instantiates
 * all services, and mounts the HTTP routes. The returned object is
 * disposable — `dispose()` closes the DB and flushes.
 *
 * Used by:
 *   - `bin.ts` in production (via startServer)
 *   - tests that want to drive HTTP handlers directly without spinning up
 *     a real TCP listener
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

import type { ServerConfig } from "../config.js";
import { openDatabase, type Db } from "../db/connection.js";
import { EventBus } from "../events.js";
import { LockManager } from "../lock.js";
import type { Logger } from "../logger.js";
import { ProjectBootstrapService } from "../services/project-bootstrap.js";
import { ProjectService } from "../services/project.js";
import { RepoService } from "../services/repo.js";
import { SubscriptionService } from "../services/subscription.js";
import { SymlinkService } from "../services/symlink.js";
import { SyncService } from "../services/sync.js";
import { SystemSkillService } from "../system-skills/service.js";
import { VERSION } from "../version.js";

import type { ServiceContainer } from "./container.js";
import { buildErrorHandler } from "./errors.js";
import { eventsRoutes } from "./routes.events.js";
import { fsRoutes } from "./routes.fs.js";
import { linksRoutes } from "./routes.links.js";
import { projectsRoutes } from "./routes.projects.js";
import { reposRoutes } from "./routes.repos.js";
import { subscriptionsRoutes } from "./routes.subscriptions.js";

export interface AppInstance {
  app: Hono;
  container: ServiceContainer;
  /** Close the DB and release resources. */
  dispose(): void;
}

export interface CreateAppOptions {
  config: ServerConfig;
  logger: Logger;
  /** Override DB (for tests with :memory:). If omitted, opens config.dbPath. */
  db?: Db;
  /** Used in the manifest's server_url field. */
  serverUrl?: string;
  /** Git commit author for push operations. */
  gitAuthor?: { name: string; email: string };
}

export function createApp(opts: CreateAppOptions): AppInstance {
  const db = opts.db ?? openDatabase({ path: opts.config.dbPath });
  const events = new EventBus();
  const locks = new LockManager({ timeoutMs: opts.config.repoLockTimeoutMs });

  // Forward-declare holder so RepoService's systemSkillIds provider can
  // read from the SystemSkillService once it's constructed, without
  // introducing a circular DI. See v0.4 spec §A9.
  let systemSkillServiceRef: SystemSkillService | null = null;

  const repoService = new RepoService({
    db,
    config: opts.config,
    events,
    locks,
    logger: opts.logger,
    systemSkillIds: () => {
      if (!systemSkillServiceRef) return new Set<string>();
      return new Set(systemSkillServiceRef.list().map((s) => s.id));
    }
  });
  const projectService = new ProjectService({
    db,
    events,
    logger: opts.logger
  });
  const subscriptionService = new SubscriptionService({
    db,
    events,
    logger: opts.logger,
    projects: projectService,
    serverUrl:
      opts.serverUrl ?? `http://${opts.config.host}:${opts.config.port}`
  });
  const symlinkService = new SymlinkService({
    db,
    events,
    logger: opts.logger,
    projects: projectService
  });
  const syncService = new SyncService({
    db,
    events,
    logger: opts.logger,
    locks,
    projects: projectService,
    subscriptions: subscriptionService,
    gitAuthor: opts.gitAuthor ?? {
      name: "Astack",
      email: "astack@localhost"
    }
  });

  // Construct after ProjectService (dependency) but before the container is
  // exposed so routes can call into it. Subscribes to project.registered events.
  const systemSkillService = new SystemSkillService({
    events,
    logger: opts.logger,
    projects: projectService
  });
  systemSkillServiceRef = systemSkillService;

  // v0.5: bootstrap last — depends on projects, subscriptions, systemSkills.
  // PR4 will wire the project.registered subscriber inside this service;
  // PR3 just exposes the routes.
  const projectBootstrapService = new ProjectBootstrapService({
    db,
    events,
    logger: opts.logger,
    locks,
    projects: projectService,
    subscriptions: subscriptionService,
    systemSkills: systemSkillService
  });

  const container: ServiceContainer = {
    config: opts.config,
    db,
    events,
    locks,
    logger: opts.logger,
    repoService,
    projectService,
    subscriptionService,
    symlinkService,
    syncService,
    systemSkillService,
    projectBootstrapService
  };

  const app = new Hono();

  // Health probe — used by CLI to detect daemon liveness.
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      version: VERSION,
      uptime_ms: Math.round(process.uptime() * 1000)
    })
  );

  app.route("/api/repos", reposRoutes(container));
  app.route("/api/projects", projectsRoutes(container));
  app.route("/api/projects", subscriptionsRoutes(container));
  app.route("/api/projects", linksRoutes(container));
  app.route("/api/fs", fsRoutes(container));
  app.route("/api", eventsRoutes(container));

  // Static dashboard: serve the @astack/web build when present. The CLI's
  // 'astack server start' command is the only supported production path,
  // and it bundles the compiled dashboard next to @astack/server.
  const dashboardDir = locateDashboard();
  if (dashboardDir) {
    // v0.6 DX: log the dashboard bundle location + mtime on every server
    // start. The most common "my code change didn't show up" bug is
    // `astack server stop && start` WITHOUT first running the web build —
    // the server still serves the old packages/web/dist. Surfacing the
    // build timestamp in the daemon log makes that invisible coupling
    // debuggable: compare this `mtime` against when you last edited the
    // web source.
    try {
      const indexStat = fs.statSync(path.join(dashboardDir, "index.html"));
      opts.logger.info("dashboard.serving", {
        dir: dashboardDir,
        index_mtime: indexStat.mtime.toISOString(),
        // Human-friendly "built N seconds ago" nudge so the number in
        // the log is interpretable at a glance without comparing
        // timestamps by hand.
        age_seconds: Math.round((Date.now() - indexStat.mtimeMs) / 1000)
      });
    } catch {
      // Stat failure is non-fatal — we verified the path exists above
      // in locateDashboard; a race where it disappears between calls is
      // acceptable to swallow because the static route will 404
      // cleanly for the user.
    }

    // Serve assets first (long-cacheable) …
    app.use("/assets/*", serveStatic({ root: path.relative(process.cwd(), dashboardDir) }));
    // … then fall back to index.html for any non-API GET so the SPA
    // router can handle deep links like /resolve/1/2.
    app.get("*", (c, next) => {
      if (c.req.path.startsWith("/api/")) return next();
      if (c.req.path.startsWith("/health")) return next();
      const indexPath = path.join(dashboardDir, "index.html");
      if (!fs.existsSync(indexPath)) return next();
      return c.body(fs.readFileSync(indexPath, "utf8"), 200, {
        "content-type": "text/html; charset=utf-8",
        // Prevent browsers / proxies from caching the SPA shell. The
        // `/assets/*` bundles are already content-hashed by Vite so
        // they're safely immutable, but index.html itself MUST be
        // revalidated each load — otherwise a stale index points at
        // deleted asset filenames after rebuild and the app
        // whitescreens until you hard-refresh.
        "cache-control": "no-cache, no-store, must-revalidate"
      });
    });
  } else {
    opts.logger.info("dashboard.missing", {
      hint: "run `pnpm -C packages/web build` (or `pnpm dev:refresh`) to build the web bundle"
    });
  }

  app.onError(buildErrorHandler(opts.logger));

  return {
    app,
    container,
    dispose: () => {
      if (!opts.db) {
        db.close();
      }
    }
  };
}

/**
 * Locate the compiled dashboard directory.
 *
 * @astack/web is a workspace peer; when users install astack globally via
 * npm, the dashboard dist lives alongside @astack/server's dist. We try
 * a few reasonable locations and return null if none exist — the daemon
 * then runs API-only.
 */
function locateDashboard(): string | null {
  const require_ = createRequire(import.meta.url);
  const candidates: string[] = [];

  // 1. Resolve via the package export (works in pnpm workspace + npm global).
  try {
    const webPkg = require_.resolve("@astack/web/package.json");
    candidates.push(path.join(path.dirname(webPkg), "dist"));
  } catch {
    // Package not available — fall through.
  }

  // 2. Adjacent to server/dist in the monorepo (development fallback).
  try {
    const url = new URL("../../../web/dist", import.meta.url);
    candidates.push(url.pathname);
  } catch {
    // ignore
  }

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "index.html"))) return c;
  }
  return null;
}
