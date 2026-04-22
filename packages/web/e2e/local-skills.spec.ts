/**
 * Local Skills E2E (v0.7 PR6).
 *
 * Coverage matrix (spec §1.22 — 3 scenarios):
 *
 *  1. **Legacy register → auto-adopt all unmatched visible**
 *     A project already has `.claude/{skills,commands,agents}` content
 *     seeded by the user (e.g. FinClaw). Register it and confirm the
 *     Local Skills tab shows all entries as `origin=auto` rows with the
 *     auto-adopt banner. No registered repo is required for this path —
 *     the scanner finds unmatched entries and the bootstrap service
 *     auto-adopts them.
 *
 *  2. **Manual adopt + unadopt round-trip**
 *     A project is registered (empty `.claude/`) → drop a new file on
 *     disk post-register → Rescan → the new entry shows up as a
 *     suggestion (because auto-adopt runs only at bootstrap time) →
 *     Adopt from drawer → row appears with origin=adopted → Unadopt →
 *     row disappears, file on disk kept (delete_files=false default).
 *
 *  3. **Rescan discovers missing**
 *     Seed a command, register (auto-adopt picks it up) → delete the
 *     file on disk directly → Rescan → row transitions to the Missing
 *     badge. Confirms drift detection works.
 *
 * Async caveat: `registerProject()` kicks off bootstrap asynchronously.
 * We poll the local-skills daemon endpoint until the auto-adopt rows
 * appear BEFORE driving the UI, because UI page load may race ahead of
 * bootstrap completion. This matches the v0.5 E2E pattern.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "@playwright/test";

import {
  daemonUrl,
  registerProject,
  resetServerState
} from "./fixtures/helpers.js";

/** Seed a .claude/ directory with commands + skills + agents for testing. */
function seedClaudeTree(
  projectDir: string,
  items: {
    skills?: string[];
    commands?: string[];
    agents?: string[];
  }
): void {
  for (const name of items.skills ?? []) {
    mkdirSync(path.join(projectDir, ".claude", "skills", name), {
      recursive: true
    });
    writeFileSync(
      path.join(projectDir, ".claude", "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Seeded E2E skill ${name}\n---\n\n# ${name}\n`
    );
  }
  for (const name of items.commands ?? []) {
    mkdirSync(path.join(projectDir, ".claude", "commands"), { recursive: true });
    writeFileSync(
      path.join(projectDir, ".claude", "commands", `${name}.md`),
      `---\ndescription: Seeded E2E command ${name}\n---\n\nRun ${name}.\n`
    );
  }
  for (const name of items.agents ?? []) {
    mkdirSync(path.join(projectDir, ".claude", "agents"), { recursive: true });
    writeFileSync(
      path.join(projectDir, ".claude", "agents", `${name}.md`),
      `---\nname: ${name}\ndescription: Seeded E2E agent ${name}\n---\n\nAgent ${name}.\n`
    );
  }
}

/**
 * Poll the daemon local-skills endpoint until the row count reaches
 * `expectedCount` (or timeout). Returns the final list once satisfied.
 *
 * Bootstrap runs async inside the daemon after `POST /api/projects`, so
 * the UI may navigate before auto-adopt has written the local_skills
 * rows. Polling the API here gives us a stable signal that the data is
 * ready before we start asserting against the DOM.
 */
async function waitForLocalSkillsCount(
  request: APIRequestContext,
  projectId: number,
  expectedCount: number,
  timeoutMs = 15_000
): Promise<Array<{ type: string; name: string; origin: string; status: string }>> {
  const deadline = Date.now() + timeoutMs;
  let last: Array<{ type: string; name: string; origin: string; status: string }> = [];
  while (Date.now() < deadline) {
    const res = await request.get(`${daemonUrl}/api/projects/${projectId}/local-skills`);
    if (res.ok()) {
      const body = (await res.json()) as {
        items: Array<{ type: string; name: string; origin: string; status: string }>;
      };
      last = body.items;
      if (last.length >= expectedCount) return last;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `waitForLocalSkillsCount: only got ${last.length}/${expectedCount} after ${timeoutMs}ms`
  );
}

/**
 * Poll the daemon suggestions endpoint until at least `expectedCount`
 * unmatched items are returned.
 */
async function waitForSuggestionsCount(
  request: APIRequestContext,
  projectId: number,
  expectedCount: number,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    const res = await request.get(
      `${daemonUrl}/api/projects/${projectId}/local-skills/suggestions`
    );
    if (res.ok()) {
      const body = (await res.json()) as { suggestions: unknown[] };
      last = body.suggestions.length;
      if (last >= expectedCount) return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `waitForSuggestionsCount: only got ${last}/${expectedCount} after ${timeoutMs}ms`
  );
}

test.describe("local skills — legacy auto-adopt", () => {
  let projectDir: string;

  test.beforeEach(async ({ request }) => {
    await resetServerState(request);
    projectDir = mkdtempSync(path.join(tmpdir(), "astack-e2e-ls-auto-"));
  });

  test.afterEach(() => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  test("legacy .claude/ entries auto-adopt on register and render in Local Skills tab", async ({
    page,
    request
  }) => {
    // Scenario 1 — seed 1 skill + 2 commands BEFORE registering. No repo
    // is registered, so all entries are unmatched and eligible for
    // auto-adopt per §1.14 / §A2.
    seedClaudeTree(projectDir, {
      skills: ["iwiki"],
      commands: ["dev", "mr"]
    });

    const project = await registerProject(request, projectDir);

    // Bootstrap runs async; wait for the 3 auto-adopt rows before the UI.
    const items = await waitForLocalSkillsCount(request, project.id, 3);
    expect(items.every((it) => it.origin === "auto")).toBe(true);

    await page.goto(`/projects/${project.id}?tab=local-skills`);
    await expect(
      page.getByRole("tab", { name: /Local Skills/ })
    ).toHaveAttribute("aria-selected", "true");

    // Auto-adopt banner visible because origin=auto rows exist and
    // localStorage is clean.
    await expect(
      page.getByTestId("local-skills-auto-adopt-banner")
    ).toBeVisible();
    await expect(
      page.getByTestId("local-skills-auto-adopt-banner")
    ).toContainText(/3 local skills auto-adopted/i);

    // Each group is rendered.
    await expect(
      page.getByRole("region", { name: "Skills" })
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Commands" })
    ).toBeVisible();

    // Each row carries origin=auto (badge tooltip matches).
    const autoBadges = page.locator(
      "span[title='Auto-adopted from existing .claude/']"
    );
    await expect(autoBadges).toHaveCount(3);

    // Names surface in the table.
    await expect(page.getByText("iwiki").first()).toBeVisible();
    await expect(page.getByText("dev").first()).toBeVisible();
    await expect(page.getByText("mr").first()).toBeVisible();
  });
});

test.describe("local skills — manual adopt + unadopt round-trip", () => {
  let projectDir: string;

  test.beforeEach(async ({ request }) => {
    await resetServerState(request);
    projectDir = mkdtempSync(path.join(tmpdir(), "astack-e2e-ls-manual-"));
  });

  test.afterEach(() => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  test("newly-dropped file shows as suggestion → adopt → unadopt round-trip", async ({
    page,
    request
  }) => {
    // Scenario 2 — register an empty project first, then drop a file on
    // disk post-registration so auto-adopt does NOT catch it (auto-adopt
    // runs only at bootstrap time; subsequent drops become suggestions).
    mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
    const project = await registerProject(request, projectDir);

    // Drop a file AFTER registration.
    mkdirSync(path.join(projectDir, ".claude", "commands"), { recursive: true });
    writeFileSync(
      path.join(projectDir, ".claude", "commands", "foo.md"),
      "---\ndescription: Post-register foo command\n---\n\nfoo.\n"
    );

    await page.goto(`/projects/${project.id}?tab=local-skills`);
    // Rescan via the tab button (drives API; fires local_skills.changed).
    await page.getByRole("button", { name: /^Rescan$/ }).click();

    // Wait for the suggestion to land at the daemon before asserting UI.
    await waitForSuggestionsCount(request, project.id, 1);

    // Header button reflects the suggestion count.
    await expect(
      page.getByRole("button", {
        name: /\+ Adopt from suggestions \(1\)/
      })
    ).toBeVisible({ timeout: 10_000 });

    // Open AdoptDrawer, tick foo, apply.
    await page.getByRole("button", {
      name: /\+ Adopt from suggestions \(1\)/
    }).click();
    const checkbox = page.getByRole("checkbox", { name: /Adopt command foo/i });
    await expect(checkbox).toBeVisible();
    await checkbox.check();
    await page.getByRole("button", { name: /^Adopt \(1\)$/ }).click();

    // Wait for the row to actually land at the daemon.
    await waitForLocalSkillsCount(request, project.id, 1);

    // Row renders with origin=adopted (manual) — not the auto tooltip.
    await expect(
      page.locator("span[title='Manually adopted']").first()
    ).toBeVisible({ timeout: 10_000 });

    // Unadopt — set up dialog handlers that ACCEPT the unadopt confirm
    // and DISMISS the "also delete file on disk?" confirm so the file
    // stays on disk (non-destructive default per §A4).
    let dialogCount = 0;
    page.on("dialog", async (dialog) => {
      dialogCount += 1;
      if (dialogCount === 1) {
        await dialog.accept();
      } else {
        await dialog.dismiss();
      }
    });
    await page.getByRole("button", { name: /Unadopt foo/i }).click();

    // Wait for row to disappear at the daemon level.
    await waitForLocalSkillsCount(request, project.id, 0).catch(() => {
      // waitForLocalSkillsCount throws if count never reaches target.
      // Use a direct API probe here instead so the test surfaces a
      // clearer assertion failure.
    });
    const finalRes = await request.get(
      `${daemonUrl}/api/projects/${project.id}/local-skills`
    );
    const { items } = (await finalRes.json()) as { items: unknown[] };
    expect(items).toHaveLength(0);

    // File on disk still exists (delete_files=false was the default).
    expect(
      existsSync(path.join(projectDir, ".claude", "commands", "foo.md"))
    ).toBe(true);
  });
});

test.describe("local skills — rescan discovers missing", () => {
  let projectDir: string;

  test.beforeEach(async ({ request }) => {
    await resetServerState(request);
    projectDir = mkdtempSync(path.join(tmpdir(), "astack-e2e-ls-missing-"));
  });

  test.afterEach(() => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  test("deleting an adopted file on disk surfaces as Missing after Rescan", async ({
    page,
    request
  }) => {
    // Scenario 3 — seed a command, register (auto-adopt picks it up),
    // then delete the file on disk, Rescan, expect the Missing badge.
    seedClaudeTree(projectDir, { commands: ["ghost"] });
    const project = await registerProject(request, projectDir);

    // Wait for auto-adopt.
    await waitForLocalSkillsCount(request, project.id, 1);

    await page.goto(`/projects/${project.id}?tab=local-skills`);

    // Confirm the row is present before we nuke the file.
    await expect(page.getByText("ghost").first()).toBeVisible({ timeout: 10_000 });

    // Nuke the file on disk.
    unlinkSync(path.join(projectDir, ".claude", "commands", "ghost.md"));

    // Rescan via the tab button.
    await page.getByRole("button", { name: /^Rescan$/ }).click();

    // Poll until the daemon reports the row as missing.
    const deadline = Date.now() + 10_000;
    let sawMissing = false;
    while (Date.now() < deadline) {
      const res = await request.get(
        `${daemonUrl}/api/projects/${project.id}/local-skills`
      );
      if (res.ok()) {
        const { items } = (await res.json()) as {
          items: Array<{ status: string; name: string }>;
        };
        const ghost = items.find((it) => it.name === "ghost");
        if (ghost && ghost.status === "missing") {
          sawMissing = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(sawMissing).toBe(true);

    // Missing badge rendered.
    await expect(page.getByLabel("Status: Missing")).toBeVisible({
      timeout: 10_000
    });
  });
});
