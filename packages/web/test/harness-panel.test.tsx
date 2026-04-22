/**
 * HarnessPanel unit tests (v0.4 PR5, v0.7 scaffold extension).
 *
 * Covers:
 *   - 5 statuses render correct label + button copy
 *   - drift surface shows the "will be overwritten" advisory
 *   - scaffold_incomplete surface shows missing files + /init_harness hint
 *   - seed_failed surface shows last_error
 *   - Re-install triggers api.installHarness + updates state
 *   - Show instructions expand/collapse with /init_harness content
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HarnessPanel } from "../src/components/project/HarnessPanel.js";
import { SseProvider } from "../src/lib/sse.js";
import { ToastProvider } from "../src/lib/toast.js";

import {
  HARNESS_SCAFFOLD_FILES,
  type ProjectHarnessState
} from "@astack/shared";

const BASE_SKILL = {
  id: "harness-init",
  name: "Harness governance bootstrap",
  description: "test description",
  source_path: "/tmp/source",
  content_hash: "deadbeef".repeat(8)
};

function makeState(
  status: ProjectHarnessState["status"],
  extras: Partial<ProjectHarnessState> = {}
): ProjectHarnessState {
  const scaffoldComplete =
    status === "installed" ||
    status === "drift" ||
    status === "missing" ||
    status === "seed_failed";
  // For `installed`, scaffold must be complete. For everything else we
  // default to "complete" too — tests for scaffold_incomplete pass an
  // explicit override below.
  return {
    project_id: 1,
    skill: BASE_SKILL,
    status,
    seeded_at: status === "missing" ? null : "2026-04-20T21:00:00.000Z",
    stub_built_in_hash: BASE_SKILL.content_hash,
    actual_hash: status === "drift" ? "aaaa".repeat(16) : null,
    last_error: status === "seed_failed" ? "disk full" : null,
    scaffold:
      status === "scaffold_incomplete"
        ? {
            files: [...HARNESS_SCAFFOLD_FILES],
            missing: ["AGENTS.md", "docs/version/INDEX.md"],
            complete: false
          }
        : scaffoldComplete
          ? {
              files: [...HARNESS_SCAFFOLD_FILES],
              missing: [],
              complete: true
            }
          : {
              files: [...HARNESS_SCAFFOLD_FILES],
              missing: [...HARNESS_SCAFFOLD_FILES],
              complete: false
            },
    ...extras
  };
}

function mountHarness(): void {
  render(
    <ToastProvider>
      <SseProvider>
        <HarnessPanel projectId={1} />
      </SseProvider>
    </ToastProvider>
  );
}

describe("HarnessPanel", () => {
  let origFetch: typeof fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  function stubFetch(
    routes: Record<string, () => ProjectHarnessState>
  ): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      for (const [pattern, fn] of Object.entries(routes)) {
        if (url.endsWith(pattern) || url.includes(pattern)) {
          return new Response(JSON.stringify(fn()), { status: 200 });
        }
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    return fetchMock;
  }

  it("renders Installed status", async () => {
    stubFetch({ "/harness": () => makeState("installed") });
    mountHarness();
    await waitFor(() => expect(screen.getByText("Installed")).toBeInTheDocument());
    expect(
      screen.getByText(/all governance files .* are in place/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /re-install/i })
    ).toBeInTheDocument();
  });

  it("renders Drift with overwrite advisory", async () => {
    stubFetch({ "/harness": () => makeState("drift") });
    mountHarness();
    await waitFor(() => expect(screen.getByText("Drift detected")).toBeInTheDocument());
    expect(
      screen.getByText(/will be overwritten the next time you click Re-install/i)
    ).toBeInTheDocument();
  });

  it("renders Scaffold incomplete with missing files + /init_harness hint", async () => {
    stubFetch({ "/harness": () => makeState("scaffold_incomplete") });
    mountHarness();
    await waitFor(() =>
      expect(screen.getByText("Scaffold incomplete")).toBeInTheDocument()
    );
    // Detail text should mention the slash command — there are several
    // mentions now (header explainer + status detail), we only care that
    // at least one mentions /init_harness verbatim inside this panel.
    expect(screen.getAllByText(/\/init_harness/).length).toBeGreaterThan(0);
    // Missing files are listed inside the dedicated ScaffoldMissingBlock
    // group — scope the queries there because the header explainer also
    // mentions `AGENTS.md` / `docs/version/` as part of its prose.
    const missingBlock = screen.getByRole("group", {
      name: /missing scaffold files/i
    });
    expect(within(missingBlock).getByText("AGENTS.md")).toBeInTheDocument();
    expect(
      within(missingBlock).getByText("docs/version/INDEX.md")
    ).toBeInTheDocument();
    // Re-install (not Install) because the skill itself is present.
    expect(
      screen.getByRole("button", { name: /re-install/i })
    ).toBeInTheDocument();
  });

  it("renders Missing with Install button", async () => {
    stubFetch({ "/harness": () => makeState("missing") });
    mountHarness();
    await waitFor(() => expect(screen.getByText("Not installed")).toBeInTheDocument());
    expect(
      screen.getByRole("button", { name: /^install$/i })
    ).toBeInTheDocument();
  });

  it("renders seed_failed with last_error visible", async () => {
    stubFetch({ "/harness": () => makeState("seed_failed") });
    mountHarness();
    await waitFor(() => expect(screen.getByText("Install failed")).toBeInTheDocument());
    expect(screen.getByText("disk full")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /retry install/i })
    ).toBeInTheDocument();
  });

  it("Re-install triggers installHarness and updates displayed status", async () => {
    const user = userEvent.setup();
    let currentStatus: ProjectHarnessState["status"] = "drift";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/harness/install")) {
        currentStatus = "installed";
        return new Response(JSON.stringify(makeState("installed")), {
          status: 200
        });
      }
      if (url.includes("/harness")) {
        return new Response(JSON.stringify(makeState(currentStatus)), {
          status: 200
        });
      }
      void init;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    mountHarness();
    await waitFor(() => expect(screen.getByText("Drift detected")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /re-install/i }));

    await waitFor(() => expect(screen.getByText("Installed")).toBeInTheDocument());
  });

  it("Show instructions toggles a block pointing at /init_harness (no raw shell)", async () => {
    const user = userEvent.setup();
    stubFetch({ "/harness": () => makeState("installed") });
    mountHarness();
    await waitFor(() => expect(screen.getByText("Installed")).toBeInTheDocument());

    // The header always mentions /init_harness (namespace explainer), but
    // the Instructions block — identified by its "Prerequisite" note —
    // must not be visible before the toggle.
    expect(
      screen.queryByRole("note", { name: /prerequisite/i })
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /show instructions/i })
    );

    // The instructions block is now visible.
    const prereq = screen.getByRole("note", { name: /prerequisite/i });
    expect(prereq).toBeInTheDocument();
    // It calls out that /init_harness is a subscribable command, not a
    // bundled entry point. The prose spans multiple elements (<code>,
    // <span>), so match against the concatenated textContent.
    const prereqText = prereq.textContent ?? "";
    expect(prereqText).toMatch(/not\s+bundled with astack/i);
    expect(prereqText.toLowerCase()).toContain("subscriptions");
    // Must NOT advertise the raw shell command any more.
    expect(screen.queryByText(/init-harness\.sh/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/bash .*init-harness/i)).not.toBeInTheDocument();
    // Button label toggles.
    expect(
      screen.getByRole("button", { name: /hide instructions/i })
    ).toBeInTheDocument();
  });

  it("v0.7 B1: header distinguishes system skill `harness-init` from the slash command `/init_harness`", async () => {
    stubFetch({ "/harness": () => makeState("installed") });
    mountHarness();
    await waitFor(() => expect(screen.getByText("Installed")).toBeInTheDocument());

    // A `system` badge marks the panel as an astack-bundled resource.
    expect(screen.getByText("system")).toBeInTheDocument();
    // Body copy names both the skill and the command so users can't
    // conflate them.
    expect(screen.getByText(/harness-init/)).toBeInTheDocument();
    expect(screen.getAllByText(/\/init_harness/).length).toBeGreaterThan(0);
  });

  it("API fetch is issued to /api/projects/:id/harness", async () => {
    const fetchMock = stubFetch({ "/harness": () => makeState("installed") });
    mountHarness();
    await waitFor(() => expect(screen.getByText("Installed")).toBeInTheDocument());

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith("/api/projects/1/harness"))).toBe(true);
  });

  it("suppresses unused helper import warning (within)", () => {
    // `within` is imported for parity with other tests but isn't strictly
    // needed here. Reference it so tsc/eslint don't strip the import.
    void within;
  });
});
