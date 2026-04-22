/**
 * Web unit tests for v0.7 Local Skills UI (PR5).
 *
 * Covers spec §1.22 test matrix (≥5 cases):
 *   1. LocalSkillsPanel empty with suggestions → "Review & Adopt" CTA
 *   2. LocalSkillsPanel renders rows + all 4 status badges
 *   3. AdoptDrawer submit calls onApply with selected entries
 *   4. Unadopt confirms + defaults delete_files to false
 *   5. name_collision row shows Collision badge + tooltip copy
 *
 * Bonus: auto-adopt banner visibility toggles on Dismiss.
 */

import type {
  ApplyLocalSkillsResult,
  BootstrapUnmatched,
  LocalSkill,
  SkillType,
  UnadoptLocalSkillsResult
} from "@astack/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdoptDrawer } from "../src/components/project/AdoptDrawer.js";
import {
  LOCAL_SKILL_STATUS_INFO,
  LocalSkillsPanel
} from "../src/components/project/LocalSkillsPanel.js";

function makeRow(overrides: Partial<LocalSkill> = {}): LocalSkill {
  return {
    id: overrides.id ?? "00000000-0000-4000-8000-000000000000",
    project_id: 1,
    type: overrides.type ?? "skill",
    name: overrides.name ?? "code-simplifier",
    rel_path: overrides.rel_path ?? "skills/code-simplifier",
    description: overrides.description ?? null,
    origin: overrides.origin ?? "adopted",
    status: overrides.status ?? "present",
    content_hash: overrides.content_hash ?? "abc123",
    adopted_at: overrides.adopted_at ?? "2026-04-22T00:00:00Z",
    last_seen_at: overrides.last_seen_at ?? "2026-04-22T00:00:00Z",
    ...overrides
  };
}

function makeSuggestion(
  name: string,
  type: SkillType = "command"
): BootstrapUnmatched {
  return {
    type,
    name,
    local_path:
      type === "skill" ? `skills/${name}` : `${type}s/${name}.md`
  };
}

function defaultProps(
  overrides: Partial<React.ComponentProps<typeof LocalSkillsPanel>> = {}
): React.ComponentProps<typeof LocalSkillsPanel> {
  return {
    projectId: 1,
    localSkills: overrides.localSkills ?? [],
    suggestions: overrides.suggestions ?? [],
    onAdopt:
      overrides.onAdopt ??
      vi.fn<
        [Array<{ type: SkillType; name: string }>],
        Promise<ApplyLocalSkillsResult>
      >(async () => ({ succeeded: [], failed: [] })),
    onUnadopt:
      overrides.onUnadopt ??
      vi.fn<
        [
          { type: SkillType; name: string },
          { delete_files: boolean }
        ],
        Promise<UnadoptLocalSkillsResult>
      >(async () => ({
        unadopted: [],
        files_deleted: [],
        failed: []
      })),
    onRescan: overrides.onRescan ?? vi.fn()
  };
}

beforeEach(() => {
  // Spec §1.15 banner dismissal key — reset between tests so each case
  // starts with the banner re-visible. Done in beforeEach (not afterEach)
  // so the first test in the file can rely on a clean slate regardless
  // of which file ran before.
  //
  // Some jsdom setups replace window.localStorage with a plain object in
  // cross-test scenarios. We defensively install a real in-memory Storage
  // polyfill on each test's window so the component's localStorage writes
  // survive between render() calls within the same test.
  try {
    const store = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return store.size;
      },
      clear: () => {
        store.clear();
      },
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      removeItem: (key: string) => {
        store.delete(key);
      },
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      }
    };
    Object.defineProperty(window, "localStorage", {
      value: storage,
      configurable: true,
      writable: true
    });
  } catch {
    // ignore — best-effort
  }
});

// ---------- LocalSkillsPanel ----------

describe("LocalSkillsPanel", () => {
  it("shows the 'Review & Adopt' empty state when no rows but N suggestions exist", () => {
    render(
      <LocalSkillsPanel
        {...defaultProps({
          suggestions: [
            makeSuggestion("dev"),
            makeSuggestion("mr"),
            makeSuggestion("spec")
          ]
        })}
      />
    );

    // Empty-state copy mentions the count and points at the drawer. The
    // copy embeds `.claude/` in a <code> element, so text is split across
    // nodes — we assert the surrounding fragments separately.
    expect(
      screen.getByText(/3 local skills found under/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/none adopted yet/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Review & Adopt/i })
    ).toBeInTheDocument();
    // Header button also carries the count so the nudge is symmetric
    // between header and empty state.
    expect(
      screen.getByRole("button", {
        name: /\+ Adopt from suggestions \(3\)/
      })
    ).toBeInTheDocument();
  });

  it("renders rows grouped by type with each of the 4 status badges", () => {
    const rows: LocalSkill[] = [
      makeRow({
        id: "1",
        type: "skill",
        name: "alpha",
        status: "present",
        rel_path: "skills/alpha"
      }),
      makeRow({
        id: "2",
        type: "skill",
        name: "beta",
        status: "modified",
        rel_path: "skills/beta"
      }),
      makeRow({
        id: "3",
        type: "command",
        name: "gamma",
        status: "missing",
        rel_path: "commands/gamma.md"
      }),
      makeRow({
        id: "4",
        type: "agent",
        name: "delta",
        status: "name_collision",
        rel_path: "agents/delta.md"
      })
    ];
    render(<LocalSkillsPanel {...defaultProps({ localSkills: rows })} />);

    // Verify each status badge text is in the DOM exactly once.
    expect(
      screen.getAllByLabelText(
        `Status: ${LOCAL_SKILL_STATUS_INFO.present.label}`
      )
    ).toHaveLength(1);
    expect(
      screen.getAllByLabelText(
        `Status: ${LOCAL_SKILL_STATUS_INFO.modified.label}`
      )
    ).toHaveLength(1);
    expect(
      screen.getAllByLabelText(
        `Status: ${LOCAL_SKILL_STATUS_INFO.missing.label}`
      )
    ).toHaveLength(1);
    expect(
      screen.getAllByLabelText(
        `Status: ${LOCAL_SKILL_STATUS_INFO.name_collision.label}`
      )
    ).toHaveLength(1);

    // Groups are rendered for all three populated types.
    expect(
      screen.getByRole("region", { name: "Skills" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Commands" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Agents" })
    ).toBeInTheDocument();
  });

  it("shows the name_collision tooltip on the collision badge", () => {
    render(
      <LocalSkillsPanel
        {...defaultProps({
          localSkills: [
            makeRow({ name: "skill-creator", status: "name_collision" })
          ]
        })}
      />
    );

    const badge = screen.getByLabelText(
      `Status: ${LOCAL_SKILL_STATUS_INFO.name_collision.label}`
    );
    // Badge tone warn maps to orange via project's `text-warn` token.
    expect(badge.className).toMatch(/text-warn/);
    // Tooltip is carried via the `title` attribute so hover surfaces
    // the spec §1.15 matrix copy.
    expect(badge).toHaveAttribute(
      "title",
      LOCAL_SKILL_STATUS_INFO.name_collision.tooltip ?? ""
    );
  });

  it("Unadopt prompts twice and defaults delete_files to false on cancel", async () => {
    const user = userEvent.setup();
    const confirmMock = vi
      .spyOn(window, "confirm")
      // First confirm: "Unadopt? astack stops tracking" → yes
      .mockImplementationOnce(() => true)
      // Second confirm: "Also delete file on disk?" → CANCEL → false (default)
      .mockImplementationOnce(() => false);
    const onUnadopt = vi.fn<
      [
        { type: SkillType; name: string },
        { delete_files: boolean }
      ],
      Promise<UnadoptLocalSkillsResult>
    >(async () => ({
      unadopted: [{ type: "skill", name: "alpha" }],
      files_deleted: [],
      failed: []
    }));

    render(
      <LocalSkillsPanel
        {...defaultProps({
          localSkills: [makeRow({ name: "alpha" })],
          onUnadopt
        })}
      />
    );

    await user.click(
      screen.getByRole("button", { name: /Unadopt alpha/i })
    );

    await waitFor(() => expect(onUnadopt).toHaveBeenCalledOnce());
    // Spec §A4 — default is non-destructive.
    expect(onUnadopt.mock.calls[0]![1]).toEqual({ delete_files: false });
    expect(confirmMock).toHaveBeenCalledTimes(2);

    confirmMock.mockRestore();
  });

  it("auto-adopt banner shows once and hides after Dismiss (localStorage flag)", async () => {
    const user = userEvent.setup();
    const rows = [
      makeRow({ origin: "auto", name: "dev", rel_path: "commands/dev.md" })
    ];
    const { unmount } = render(
      <LocalSkillsPanel {...defaultProps({ localSkills: rows })} />
    );

    // Banner visible on first render when localStorage is clean. We use
    // getByTestId because testing-library's role="note" accessible-name
    // and getByLabelText-on-div resolution are both unreliable under
    // jsdom; the banner element carries an explicit data-testid for
    // this purpose.
    const banner = screen.getByTestId("local-skills-auto-adopt-banner");
    expect(banner).toBeInTheDocument();
    await user.click(within(banner).getByRole("button", { name: /Dismiss/i }));

    // After Dismiss click, the banner is removed from DOM immediately
    // because setState hides it.
    expect(
      screen.queryByTestId("local-skills-auto-adopt-banner")
    ).not.toBeInTheDocument();

    // Re-render (simulates SSE/refetch) — banner stays hidden because
    // the dismissal persisted in localStorage. We fully unmount and
    // render a fresh tree to simulate the component remounting after
    // an SSE-triggered data refresh (which recreates the panel).
    unmount();
    render(<LocalSkillsPanel {...defaultProps({ localSkills: rows })} />);
    expect(
      screen.queryByTestId("local-skills-auto-adopt-banner")
    ).not.toBeInTheDocument();
  });
});

// ---------- AdoptDrawer ----------

describe("AdoptDrawer", () => {
  it("submits selected entries to onApply and closes on full success", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn<
      [Array<{ type: SkillType; name: string }>],
      Promise<ApplyLocalSkillsResult>
    >(async (entries) => ({
      succeeded: entries.map((e) => ({
        ...e,
        local_skill_id: `id-${e.name}`
      })),
      failed: []
    }));
    const onClose = vi.fn();

    render(
      <AdoptDrawer
        open={true}
        onClose={onClose}
        suggestions={[
          makeSuggestion("dev", "command"),
          makeSuggestion("mr", "command"),
          makeSuggestion("iwiki", "skill")
        ]}
        onApply={onApply}
      />
    );

    // Tick two checkboxes.
    await user.click(
      screen.getByRole("checkbox", { name: /Adopt command dev/i })
    );
    await user.click(
      screen.getByRole("checkbox", { name: /Adopt skill iwiki/i })
    );

    await user.click(screen.getByRole("button", { name: /Adopt \(2\)/ }));

    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    expect(onApply.mock.calls[0]![0]).toEqual([
      { type: "command", name: "dev" },
      { type: "skill", name: "iwiki" }
    ]);
    // Full success (failed == 0) closes the drawer.
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
