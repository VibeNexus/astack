/**
 * /api/projects/:id/subscriptions|sync|push|resolve routes.
 *
 * Split into a dedicated module because the subscription/sync flow is the
 * heart of the service and deserves its own route file.
 */

import {
  ErrorCode,
  ProjectParamsSchema,
  PushRequestSchema,
  ResolveRequestSchema,
  SubscribeRequestSchema,
  SyncRequestSchema,
  UnsubscribeParamsSchema,
  type PushResponse,
  type SubscribeResponse,
  type Subscription,
  type SyncResponse,
  type SyncLog,
  type ResolveResponse,
  type UnsubscribeResponse,
  AstackError
} from "@astack/shared";
import { zValidator } from "./validator.js";
import { Hono } from "hono";

import type { PushOutcome, SyncOutcome } from "../services/sync.js";

import type { ServiceContainer } from "./container.js";

export function subscriptionsRoutes(c: ServiceContainer): Hono {
  const app = new Hono();

  // POST /api/projects/:id/subscriptions — subscribe to one or more skills.
  app.post(
    "/:id/subscriptions",
    zValidator("param", ProjectParamsSchema),
    zValidator("json", SubscribeRequestSchema),
    async (ctx) => {
      const { id } = ctx.req.valid("param");
      const body = ctx.req.valid("json");

      const subs: Subscription[] = [];
      for (const ref of body.skills) {
        const { subscription } = c.subscriptionService.subscribe(id, ref, {
          type: body.type,
          pinned_version:
            body.skills.length === 1 ? body.pinned_version : undefined
        });
        subs.push(subscription);
      }

      let sync_logs: SyncLog[] = [];
      if (body.sync_now) {
        const result = await c.syncService.pullBatch(id, {
          skill_ids: subs.map((s) => s.skill_id)
        });
        sync_logs = result.outcomes.map((o: SyncOutcome) => o.log);
      }

      const response: SubscribeResponse = {
        subscriptions: subs,
        sync_logs
      };
      return ctx.json(response, 201);
    }
  );

  // DELETE /api/projects/:id/subscriptions/:skill_id — unsubscribe.
  app.delete(
    "/:id/subscriptions/:skill_id",
    zValidator("param", UnsubscribeParamsSchema),
    (ctx) => {
      const { id, skill_id } = ctx.req.valid("param");
      const deleted = c.subscriptionService.unsubscribe(id, skill_id);
      if (!deleted) {
        throw new AstackError(
          ErrorCode.SUBSCRIPTION_NOT_FOUND,
          "subscription not found",
          { project_id: id, skill_id }
        );
      }
      const response: UnsubscribeResponse = {
        deleted: true,
        file_removed: false
      };
      return ctx.json(response);
    }
  );

  // POST /api/projects/:id/sync — pull all or selected subscriptions.
  app.post(
    "/:id/sync",
    zValidator("param", ProjectParamsSchema),
    zValidator("json", SyncRequestSchema),
    async (ctx) => {
      const { id } = ctx.req.valid("param");
      const body = ctx.req.valid("json");
      const result = await c.syncService.pullBatch(id, {
        skill_ids: body.skill_ids,
        force: body.force
      });
      const response: SyncResponse = {
        outcomes: result.outcomes.map((o) => ({
          skill_id: o.skill.id,
          skill: o.skill,
          state: o.state,
          log: o.log
        })),
        synced: result.synced,
        up_to_date: result.up_to_date,
        conflicts: result.conflicts,
        errors: result.errors
      };
      return ctx.json(response);
    }
  );

  // POST /api/projects/:id/push — push local changes for selected skills.
  app.post(
    "/:id/push",
    zValidator("param", ProjectParamsSchema),
    zValidator("json", PushRequestSchema),
    async (ctx) => {
      const { id } = ctx.req.valid("param");
      const body = ctx.req.valid("json");

      const skillIds =
        body.skill_ids ??
        c.subscriptionService.listForProject(id).map((s) => s.skill_id);

      const outcomes: PushOutcome[] = [];
      let pushed = 0;
      let no_changes = 0;
      let conflicts = 0;
      let errors = 0;

      for (const skillId of skillIds) {
        try {
          const outcome = await c.syncService.pushOne(id, skillId, {
            commit_message: body.commit_message
          });
          outcomes.push(outcome);
          if (outcome.new_version) pushed++;
          else no_changes++;
        } catch (err) {
          if (
            err instanceof AstackError &&
            err.code === ErrorCode.CONFLICT_DETECTED
          ) {
            conflicts++;
            // Surface the conflict outcome so CLI/Web can show which
            // skill needs /resolve. Fetch the skill + latest log row.
            const skill = c.db
              .prepare<
                [number],
                {
                  id: number;
                  repo_id: number;
                  type: "command" | "skill";
                  name: string;
                  path: string;
                  version: string | null;
                  updated_at: string | null;
                }
              >(
                `SELECT id, repo_id, type, name, path, version, updated_at
                 FROM skills WHERE id = ?`
              )
              .get(skillId);
            const log = c.db
              .prepare<
                [number, number],
                {
                  id: number;
                  project_id: number;
                  skill_id: number;
                  direction: "pull" | "push";
                  from_version: string | null;
                  to_version: string | null;
                  status: "success" | "conflict" | "error";
                  conflict_detail: string | null;
                  synced_at: string;
                }
              >(
                `SELECT id, project_id, skill_id, direction, from_version,
                        to_version, status, conflict_detail, synced_at
                 FROM sync_logs
                 WHERE project_id = ? AND skill_id = ?
                 ORDER BY synced_at DESC, id DESC
                 LIMIT 1`
              )
              .get(id, skillId);
            if (skill && log) {
              outcomes.push({
                skill,
                state: "conflict",
                log,
                new_version: null
              } as unknown as Parameters<typeof outcomes.push>[0]);
            }
            continue;
          }
          errors++;
          c.logger.warn("push.skill_failed", {
            project_id: id,
            skill_id: skillId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }

      const response: PushResponse = {
        outcomes: outcomes.map((o) => ({
          skill_id: o.skill.id,
          skill: o.skill,
          state: o.state,
          log: o.log,
          new_version: o.new_version
        })),
        pushed,
        no_changes,
        conflicts,
        errors
      };
      return ctx.json(response);
    }
  );

  // POST /api/projects/:id/resolve — resolve a conflict.
  app.post(
    "/:id/resolve",
    zValidator("param", ProjectParamsSchema),
    zValidator("json", ResolveRequestSchema),
    async (ctx) => {
      const { id } = ctx.req.valid("param");
      const body = ctx.req.valid("json");
      const { subscription, log } = await c.syncService.resolve(
        id,
        body.skill_id,
        body.strategy,
        { manual_done: body.manual_done }
      );
      const response: ResolveResponse = { subscription, log };
      return ctx.json(response);
    }
  );

  return app;
}
