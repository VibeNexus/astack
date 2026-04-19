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

import { Hono } from "hono";

import type { ServerConfig } from "../config.js";
import { openDatabase, type Db } from "../db/connection.js";
import { EventBus } from "../events.js";
import { LockManager } from "../lock.js";
import type { Logger } from "../logger.js";
import { ProjectService } from "../services/project.js";
import { RepoService } from "../services/repo.js";
import { SubscriptionService } from "../services/subscription.js";
import { SymlinkService } from "../services/symlink.js";
import { SyncService } from "../services/sync.js";

import type { ServiceContainer } from "./container.js";
import { buildErrorHandler } from "./errors.js";
import { eventsRoutes } from "./routes.events.js";
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

  const repoService = new RepoService({
    db,
    config: opts.config,
    events,
    locks,
    logger: opts.logger
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
    syncService
  };

  const app = new Hono();

  // Health probe — used by CLI to detect daemon liveness.
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      version: "0.1.0",
      uptime_ms: Math.round(process.uptime() * 1000)
    })
  );

  app.route("/api/repos", reposRoutes(container));
  app.route("/api/projects", projectsRoutes(container));
  app.route("/api/projects", subscriptionsRoutes(container));
  app.route("/api/projects", linksRoutes(container));
  app.route("/api", eventsRoutes(container));

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
