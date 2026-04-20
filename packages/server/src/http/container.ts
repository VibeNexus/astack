/**
 * Service container passed to every route module.
 *
 * Routes should be thin — pull input out of the request, call a service
 * method, return JSON. No business logic lives in routes.
 */

import type { ServerConfig } from "../config.js";
import type { Db } from "../db/connection.js";
import type { EventBus } from "../events.js";
import type { LockManager } from "../lock.js";
import type { Logger } from "../logger.js";
import type { ProjectService } from "../services/project.js";
import type { RepoService } from "../services/repo.js";
import type { SubscriptionService } from "../services/subscription.js";
import type { SymlinkService } from "../services/symlink.js";
import type { SyncService } from "../services/sync.js";
import type { SystemSkillService } from "../system-skills/service.js";

export interface ServiceContainer {
  config: ServerConfig;
  db: Db;
  events: EventBus;
  locks: LockManager;
  logger: Logger;
  repoService: RepoService;
  projectService: ProjectService;
  subscriptionService: SubscriptionService;
  symlinkService: SymlinkService;
  syncService: SyncService;
  systemSkillService: SystemSkillService;
}
