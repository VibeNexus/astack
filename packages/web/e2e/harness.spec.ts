/**
 * Harness tab E2E (v0.4 PR6, v0.7 scaffold extension).
 *
 * Covers:
 *   1. installed happy path — project with governance scaffold → register → Harness tab shows Installed
 *   2. drift overwrite     — modify seed file → Drift → Re-install → Installed restored
 *   3. legacy preserved    — pre-existing harness-init dir → not auto-overwritten on register
 *   4. polluted repo       — user repo with skills/harness-init/ → excluded from scan (A9)
 *   5. scaffold incomplete — missing governance files → tab shows Scaffold incomplete + /init_harness hint
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  existsSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { HARNESS_SCAFFOLD_FILES } from "@astack/shared";

import {
  daemonUrl,
  registerProject,
  resetServerState
} from "./fixtures/helpers.js";

/**
 * Create the Harness governance scaffold inside `projectDir` so the tab
 * lands on `installed` after register — skipping this helper is the
 * correct way to simulate "skill seeded but /init_harness never run".
 */
function writeScaffoldFiles(projectDir: string): void {
  for (const rel of HARNESS_SCAFFOLD_FILES) {
    const abs = path.join(projectDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, `# ${rel}\n`);
  }
}

test.describe("harness tab — v0.4 system skill lifecycle", () => {
  let projectDir: string;

  test.beforeEach(async ({ request }) => {
    await resetServerState(request);
    projectDir = mkdtempSync(path.join(tmpdir(), "astack-e2e-harness-"));
  });

  test.afterEach(() => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  test("fresh register + scaffold present → Harness tab shows Installed", async ({
    page,
    request
  }) => {
    writeScaffoldFiles(projectDir);
    const project = await registerProject(request, projectDir);
    await page.goto(`/projects/${project.id}?tab=harness`);

    await expect(page.getByText("Installed", { exact: true })).toBeVisible({
      timeout: 5_000
    });
    // Advisory copy ONLY appears in drift state — assert it's NOT visible
    // in installed state.
    await expect(
      page.getByText(/will be overwritten/i)
    ).not.toBeVisible();

    // Filesystem side-effect: seed dir + stub file both present.
    expect(
      existsSync(path.join(projectDir, ".claude", "skills", "harness-init"))
    ).toBe(true);
    expect(
      existsSync(path.join(projectDir, ".astack", "system-skills.json"))
    ).toBe(true);
  });

  test("register without scaffold → Harness tab shows Scaffold incomplete and /init_harness hint", async ({
    page,
    request
  }) => {
    // Intentionally NOT calling writeScaffoldFiles — simulates a project
    // that has only the seeded skill dir, but no AGENTS.md / docs/**.
    const project = await registerProject(request, projectDir);
    await page.goto(`/projects/${project.id}?tab=harness`);

    await expect(page.getByText("Scaffold incomplete")).toBeVisible({
      timeout: 5_000
    });
    // Missing files list surfaces at least the first required path.
    await expect(page.getByText("AGENTS.md", { exact: true })).toBeVisible();
    // Status detail mentions the slash command (not bash).
    await expect(page.getByText(/\/init_harness/)).toBeVisible();

    // Clicking "Show instructions" reveals the /init_harness block, NOT
    // a raw shell command.
    await page.getByRole("button", { name: /show instructions/i }).click();
    await expect(page.getByText(/\/init_harness/).first()).toBeVisible();
    await expect(page.getByText(/init-harness\.sh/i)).not.toBeVisible();
  });

  test("drift detection + Re-install overwrite path", async ({
    page,
    request
  }) => {
    // Provide the scaffold up-front so skill-level drift is the only
    // transition this test needs to exercise.
    writeScaffoldFiles(projectDir);
    const project = await registerProject(request, projectDir);
    const skillMd = path.join(
      projectDir,
      ".claude",
      "skills",
      "harness-init",
      "SKILL.md"
    );
    // Wait for initial seed to complete before poking at files.
    await page.goto(`/projects/${project.id}?tab=harness`);
    await expect(page.getByText("Installed", { exact: true })).toBeVisible({
      timeout: 5_000
    });

    // Capture pristine content.
    const pristine = readFileSync(skillMd, "utf8");

    // User modifies the seed file.
    appendFileSync(skillMd, "\n<!-- user-added line -->\n");

    // Reload tab — drift should appear.
    await page.reload();
    await expect(page.getByText("Drift detected")).toBeVisible({
      timeout: 5_000
    });
    await expect(
      page.getByText(/will be overwritten the next time you click Re-install/i)
    ).toBeVisible();

    // Click Re-install.
    await page.getByRole("button", { name: /re-install/i }).click();

    // Status transitions back to Installed + file restored.
    await expect(page.getByText("Installed", { exact: true })).toBeVisible({
      timeout: 5_000
    });
    const restored = readFileSync(skillMd, "utf8");
    expect(restored).not.toContain("user-added line");
    expect(restored).toBe(pristine);
  });

  test("pre-existing harness-init dir is NOT overwritten on register (legacy preserved)", async ({
    page,
    request
  }) => {
    // Create a fake harness-init dir BEFORE registering.
    const fakeDir = path.join(
      projectDir,
      ".claude",
      "skills",
      "harness-init"
    );
    mkdirSync(fakeDir, { recursive: true });
    writeFileSync(path.join(fakeDir, "SKILL.md"), "USER LEGACY CONTENT");
    writeScaffoldFiles(projectDir);

    const project = await registerProject(request, projectDir);
    await page.goto(`/projects/${project.id}?tab=harness`);

    // Hash won't match built-in → status=drift.
    await expect(page.getByText("Drift detected")).toBeVisible({
      timeout: 5_000
    });

    // File content is preserved (seedIfMissing saw the dir and skipped).
    expect(readFileSync(path.join(fakeDir, "SKILL.md"), "utf8")).toBe(
      "USER LEGACY CONTENT"
    );
  });

  test("repo with skills/harness-init/ is excluded from scan (A9 polluted repo)", async ({
    request
  }) => {
    // Create a local git repo that ships a harness-init skill — the same
    // name as astack's bundled system skill. Scanner should filter it.
    const repoDir = mkdtempSync(path.join(tmpdir(), "astack-e2e-polluted-"));
    try {
      mkdirSync(path.join(repoDir, "skills", "harness-init"), {
        recursive: true
      });
      writeFileSync(
        path.join(repoDir, "skills", "harness-init", "SKILL.md"),
        "---\nname: harness-init\ndescription: POLLUTED\n---\n"
      );
      // Also add a legit sibling skill so we can assert the filter isn't
      // nuking the whole repo.
      mkdirSync(path.join(repoDir, "skills", "legit-skill"), {
        recursive: true
      });
      writeFileSync(
        path.join(repoDir, "skills", "legit-skill", "SKILL.md"),
        "---\nname: legit-skill\ndescription: ok\n---\n"
      );

      const { execSync } = await import("node:child_process");
      execSync(
        "git init -q && git add . && git -c user.email=e2e@local -c user.name=e2e commit -q -m init",
        { cwd: repoDir, stdio: "ignore" }
      );

      const registerRes = await request.post(`${daemonUrl}/api/repos`, {
        data: {
          git_url: `file://${repoDir}`,
          name: `polluted-${Date.now()}`,
          kind: "custom"
        }
      });
      expect(registerRes.ok()).toBe(true);
      const { repo } = (await registerRes.json()) as {
        repo: { id: number };
      };

      // List the repo's skills via API — harness-init should be absent,
      // legit-skill should be present.
      const skillsRes = await request.get(
        `${daemonUrl}/api/repos/${repo.id}/skills`
      );
      expect(skillsRes.ok()).toBe(true);
      const { skills } = (await skillsRes.json()) as {
        skills: Array<{ name: string; type: string }>;
      };
      const skillNames = skills
        .filter((s) => s.type === "skill")
        .map((s) => s.name);
      expect(skillNames).toContain("legit-skill");
      expect(skillNames).not.toContain("harness-init");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
