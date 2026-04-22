import { expect, test } from "@playwright/test";

import { daemonUrl, resetServerState } from "./fixtures/helpers.js";

test.describe("smoke — scaffolding is wired", () => {
  test.beforeEach(async ({ request }) => {
    await resetServerState(request);
  });

  test("daemon is reachable and reports healthy", async ({ request }) => {
    const res = await request.get(`${daemonUrl}/health`);
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { status: string; version: string };
    expect(body.status).toBe("ok");
  });

  test("dashboard root renders sidebar with core nav items", async ({ page }) => {
    await page.goto("/");
    // Sidebar brand
    await expect(page.getByText("Astack", { exact: true })).toBeVisible();
    // Primary nav (from Sidebar.tsx)
    await expect(page.getByRole("link", { name: /Dashboard/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Repos/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Projects/ })).toBeVisible();
  });

  test("projects page empty state is the default when nothing is registered", async ({
    page
  }) => {
    await page.goto("/projects");
    // EmptyState title is a styled div, not a heading — use text matcher.
    await expect(page.getByText("No projects registered")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Register your first project/ })
    ).toBeVisible();
  });
});
