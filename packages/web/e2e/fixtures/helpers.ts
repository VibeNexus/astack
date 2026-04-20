/**
 * Shared E2E test helpers.
 *
 * These talk directly to the daemon HTTP API (on ASTACK_E2E_PORT=7433) to
 * seed state between tests. Faster + more reliable than driving registration
 * flows through the UI just to set up fixtures.
 *
 * Every test should call `resetServerState()` in `beforeEach` to guarantee
 * isolation. The throwaway daemon has persistent SQLite but between-test
 * cleanup keeps specs order-independent.
 */

import type { APIRequestContext } from "@playwright/test";

const DAEMON = "http://127.0.0.1:7433";

export interface E2EProject {
  id: number;
  name: string;
  path: string;
}

/**
 * Delete all projects and repos registered in the daemon. Cheapest cleanup:
 * list → delete each. Done via daemon API so it runs out-of-band from the
 * page under test.
 */
export async function resetServerState(request: APIRequestContext): Promise<void> {
  // Projects
  const projectsRes = await request.get(`${DAEMON}/api/projects?limit=500`);
  if (projectsRes.ok()) {
    const { projects } = (await projectsRes.json()) as {
      projects: Array<{ id: number }>;
    };
    for (const p of projects) {
      await request.delete(`${DAEMON}/api/projects/${p.id}`);
    }
  }
  // Repos (skip built-in seeds if any slipped through — they have status
  // 'seeding' or 'failed' in the e2e daemon since seeds are disabled)
  const reposRes = await request.get(`${DAEMON}/api/repos?limit=500`);
  if (reposRes.ok()) {
    const { repos } = (await reposRes.json()) as {
      repos: Array<{ id: number; name: string }>;
    };
    for (const r of repos) {
      await request.delete(`${DAEMON}/api/repos/${r.id}`);
    }
  }
}

/**
 * Register a project via the daemon API. Returns the created project.
 *
 * The project path must exist as a directory on disk — in E2E we point it
 * at a tmpdir that tests have created themselves, or at the daemon's own
 * data dir (which is always present).
 */
export async function registerProject(
  request: APIRequestContext,
  absolutePath: string
): Promise<E2EProject> {
  const res = await request.post(`${DAEMON}/api/projects`, {
    data: { path: absolutePath }
  });
  if (!res.ok()) {
    throw new Error(
      `registerProject failed: ${res.status()} ${await res.text()}`
    );
  }
  const { project } = (await res.json()) as { project: E2EProject };
  return project;
}

/** Daemon URL prefix for tests that need to hit the API directly. */
export const daemonUrl = DAEMON;
