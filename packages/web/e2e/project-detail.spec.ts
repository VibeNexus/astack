/**
 * Project detail page E2E (v0.3).
 *
 * Boils down the whole "subscribe from web, not CLI" flow so regressions
 * on the Tabs / Drawer / SyncResultCard chain are caught automatically.
 *
 * Relies on the throwaway daemon (packages/web/playwright.config.ts →
 * start-server.mjs). We seed project + repo via the daemon REST API
 * rather than driving the UI for those prerequisites — faster and
 * sidesteps the PathAutocomplete autocomplete-timing flakiness.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  daemonUrl,
  registerProject,
  resetServerState
} from "./fixtures/helpers.js";

/** Create a minimal "repo-like" directory and register it as an astack repo. */
async function registerLocalRepo(
  request: import("@playwright/test").APIRequestContext
): Promise<{ id: number; name: string }> {
  // Create a local bare-ish directory that astack's register-repo flow
  // tolerates. For E2E we point at a file:// URL that git-clone can reach
  // without network. The daemon uses simple-git; file:// URLs work as
  // long as the target is a real git repo.
  const dir = mkdtempSync(path.join(tmpdir(), "astack-e2e-repo-"));
  mkdirSync(path.join(dir, "skills", "office-hours"), { recursive: true });
  writeFileSync(
    path.join(dir, "skills", "office-hours", "SKILL.md"),
    "---\nname: office-hours\ndescription: Weekly sync format\n---\n"
  );
  mkdirSync(path.join(dir, "commands"), { recursive: true });
  writeFileSync(path.join(dir, "commands", "hello.md"), "say hi\n");
  // git init the dir
  const { execSync } = await import("node:child_process");
  execSync("git init -q && git add . && git -c user.email=e2e@local -c user.name=e2e commit -q -m init", {
    cwd: dir,
    stdio: "ignore"
  });

  const res = await request.post(`${daemonUrl}/api/repos`, {
    data: {
      git_url: `file://${dir}`,
      // Unique name per invocation so reset doesn't need to nuke the
      // daemon's cloned-repos dir on disk between tests.
      name: `e2e-skills-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      kind: "custom"
    }
  });
  if (!res.ok()) {
    throw new Error(
      `register repo failed: ${res.status()} ${await res.text()}`
    );
  }
  const { repo } = (await res.json()) as {
    repo: { id: number; name: string };
  };
  return repo;
}

test.describe("project detail — v0.3 tabs + browse flow", () => {
  let projectDir: string;

  test.beforeEach(async ({ request }) => {
    await resetServerState(request);
    projectDir = mkdtempSync(path.join(tmpdir(), "astack-e2e-proj-"));
    mkdirSync(path.join(projectDir, ".claude", "skills"), { recursive: true });
    mkdirSync(path.join(projectDir, ".claude", "commands"), {
      recursive: true
    });
  });

  test.afterEach(() => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  test("renders all four tabs and switches via click + URL", async ({
    page,
    request
  }) => {
    const project = await registerProject(request, projectDir);
    await page.goto(`/projects/${project.id}`);

    // Subscriptions tab is default.
    await expect(
      page.getByRole("tab", { name: /Subscriptions/ })
    ).toHaveAttribute("aria-selected", "true");

    // Click Linked Tools → URL updates + aria flips.
    await page.getByRole("tab", { name: /Linked Tools/ }).click();
    await expect(page).toHaveURL(/\?tab=tools$/);
    await expect(
      page.getByRole("tab", { name: /Linked Tools/ })
    ).toHaveAttribute("aria-selected", "true");

    // Deep link — Sync History.
    await page.goto(`/projects/${project.id}?tab=history`);
    await expect(
      page.getByRole("tab", { name: /Sync History/ })
    ).toHaveAttribute("aria-selected", "true");

    // Invalid ?tab= falls back to subscriptions.
    await page.goto(`/projects/${project.id}?tab=hack`);
    await expect(
      page.getByRole("tab", { name: /Subscriptions/ })
    ).toHaveAttribute("aria-selected", "true");
  });

  test("empty subscriptions state shows the Browse CTA (not the CLI wall)", async ({
    page,
    request
  }) => {
    const project = await registerProject(request, projectDir);
    await page.goto(`/projects/${project.id}`);
    await expect(
      page.getByText("Subscribe to your first skill")
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Browse skills/ })
    ).toBeVisible();
  });

  test("Browse drawer opens, lists skills from registered repos, and subscribes", async ({
    page,
    request
  }) => {
    await registerLocalRepo(request);
    const project = await registerProject(request, projectDir);
    await page.goto(`/projects/${project.id}`);

    // Open drawer
    await page.getByRole("button", { name: /Browse skills/ }).click();
    await expect(
      page.getByRole("dialog", { name: "Browse skills" })
    ).toBeVisible();

    // Our seeded repo has one skill + one command — wait for them.
    await expect(page.getByText("office-hours").first()).toBeVisible();

    // Select the skill + subscribe
    await page
      .getByRole("checkbox", { name: /office-hours/ })
      .first()
      .check();
    await page.getByRole("button", { name: /Subscribe 1/ }).click();

    // Drawer closes, subscription row appears.
    await expect(
      page.getByRole("dialog", { name: "Browse skills" })
    ).toBeHidden();
    // The skill name appears in the Subscriptions table.
    await expect(
      page.getByRole("cell", { name: /office-hours/ }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("Esc closes the Browse drawer", async ({ page, request }, testInfo) => {
    // WebKit / mobile emulation handles keydown bubbling differently
    // when focus is inside a role="dialog" with a Drawer's custom trap.
    // The unit-test layer (test/ui/Drawer.test.tsx) already covers this
    // exhaustively; here we only assert the desktop chromium flow.
    testInfo.skip(
      testInfo.project.name === "mobile",
      "Esc keyboard behavior is covered by unit tests; skip on mobile."
    );
    await registerLocalRepo(request);
    const project = await registerProject(request, projectDir);
    await page.goto(`/projects/${project.id}`);

    await page.getByRole("button", { name: /Browse skills/ }).click();
    const drawer = page.getByRole("dialog", { name: "Browse skills" });
    await expect(drawer).toBeVisible();
    // Focus trap moves focus into the drawer on a requestAnimationFrame.
    // Click the drawer body first so keyboard events are bubbling from
    // inside the dialog, then press Escape.
    await drawer.click({ position: { x: 10, y: 10 } });
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  });
});

test.describe("project detail — keyboard tab nav", () => {
  let projectDir: string;

  test.beforeEach(async ({ request }) => {
    await resetServerState(request);
    projectDir = mkdtempSync(path.join(tmpdir(), "astack-e2e-proj-"));
    mkdirSync(path.join(projectDir, ".claude", "skills"), { recursive: true });
  });

  test.afterEach(() => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  test("ArrowRight from Subscriptions moves to Linked Tools with focus+selection", async ({
    page,
    request
  }) => {
    const project = await registerProject(request, projectDir);
    await page.goto(`/projects/${project.id}`);

    const subsTab = page.getByRole("tab", { name: /Subscriptions/ });
    await subsTab.focus();
    await page.keyboard.press("ArrowRight");

    const toolsTab = page.getByRole("tab", { name: /Linked Tools/ });
    await expect(toolsTab).toHaveAttribute("aria-selected", "true");
    // URL has updated.
    await expect(page).toHaveURL(/\?tab=tools$/);
  });
});
