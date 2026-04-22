/**
 * Web unit tests for v0.5 bootstrap UI (PR5).
 *
 * Covers spec §PR5 component tests (≥7 cases):
 *   1. BootstrapBanner hides when ambiguousCount === 0
 *   2. BootstrapBanner ambiguousCount=1 → singular copy
 *   3. BootstrapBanner ambiguousCount=3 → plural copy
 *   4. ResolveBootstrapDrawer initial Apply disabled
 *   5. Apply enabled after selection; click invokes onApply with payload
 *   6. "Don't subscribe" sets repo_id: null
 *   7. Drawer auto-closes when remaining_ambiguous is empty
 *   8. SubscriptionsPanel renders banner when bootstrap.ambiguous.length > 0
 *   9. SubscriptionsPanel uses unmatched variant when subs=0 + unmatched>0
 *   10. SubscriptionsPanel Re-scan button invokes onRescan
 */

import type {
  ApplyResolutionsResult,
  BootstrapAmbiguous,
  BootstrapResolution,
  GetProjectStatusResponse,
  ProjectBootstrapResult
} from "@astack/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BootstrapBanner } from "../src/components/project/BootstrapBanner.js";
import { ResolveBootstrapDrawer } from "../src/components/project/ResolveBootstrapDrawer.js";
import { SubscriptionsPanel } from "../src/components/project/SubscriptionsPanel.js";
import { ToastProvider } from "../src/lib/toast.js";

function makeAmbiguous(
  name: string,
  opts: { type?: "skill" | "command" | "agent" } = {}
): BootstrapAmbiguous {
  return {
    type: opts.type ?? "skill",
    name,
    local_path: `skills/${name}`,
    candidates: [
      {
        repo: {
          id: 1,
          name: "repoA",
          git_url: "https://example.invalid/a.git",
          kind: "custom",
          status: "ready",
          scan_config: null,
          local_path: "/tmp/a",
          head_hash: "a3f2d91",
          last_synced: null,
          created_at: "2026-04-20T00:00:00Z"
        },
        skill: {
          id: 10,
          repo_id: 1,
          type: opts.type ?? "skill",
          name,
          path: `skills/${name}`,
          description: null,
          version: null,
          updated_at: null
        }
      },
      {
        repo: {
          id: 2,
          name: "repoB",
          git_url: "https://example.invalid/b.git",
          kind: "custom",
          status: "ready",
          scan_config: null,
          local_path: "/tmp/b",
          head_hash: "7bc4e02",
          last_synced: null,
          created_at: "2026-04-20T00:00:00Z"
        },
        skill: {
          id: 11,
          repo_id: 2,
          type: opts.type ?? "skill",
          name,
          path: `skills/${name}`,
          description: null,
          version: null,
          updated_at: null
        }
      }
    ]
  };
}

// ---------- BootstrapBanner ----------

describe("BootstrapBanner", () => {
  it("renders nothing when ambiguous list is empty", () => {
    const { container } = render(
      <BootstrapBanner ambiguous={[]} onResolve={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("uses singular copy for 1 ambiguous skill and lists its name", () => {
    render(
      <BootstrapBanner
        ambiguous={[makeAmbiguous("skill-creator")]}
        onResolve={() => {}}
      />
    );
    // Headline: singular, no "Resolve" / "needs your attention" copy.
    expect(
      screen.getByText(/1 ambiguous local skill$/i)
    ).toBeInTheDocument();
    // Ambiguous skill name is listed inline so the banner can't be
    // confused with per-row Conflict rows.
    expect(screen.getByText("skill-creator")).toBeInTheDocument();
    // Button verb is "Pick repo", not "Resolve", to avoid colliding
    // with the table row's [Resolve] button.
    expect(
      screen.getByRole("button", { name: /Pick repo \(1\)/ })
    ).toBeInTheDocument();
  });

  it("uses plural copy for 3 ambiguous skills", () => {
    render(
      <BootstrapBanner
        ambiguous={[
          makeAmbiguous("alpha"),
          makeAmbiguous("beta"),
          makeAmbiguous("gamma")
        ]}
        onResolve={() => {}}
      />
    );
    expect(
      screen.getByText(/3 ambiguous local skills$/i)
    ).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.getByText("gamma")).toBeInTheDocument();
  });

  it("caps the inline name list at 3 and collapses the rest into +N more", () => {
    render(
      <BootstrapBanner
        ambiguous={[
          makeAmbiguous("a"),
          makeAmbiguous("b"),
          makeAmbiguous("c"),
          makeAmbiguous("d"),
          makeAmbiguous("e")
        ]}
        onResolve={() => {}}
      />
    );
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
    expect(screen.getByText("c")).toBeInTheDocument();
    expect(screen.queryByText("d")).not.toBeInTheDocument();
    expect(screen.queryByText("e")).not.toBeInTheDocument();
    expect(screen.getByText(/\+2 more/)).toBeInTheDocument();
  });
});

// ---------- ResolveBootstrapDrawer ----------

describe("ResolveBootstrapDrawer", () => {
  it("disables Apply when no selection is made", () => {
    render(
      <ResolveBootstrapDrawer
        open={true}
        onClose={() => {}}
        ambiguous={[makeAmbiguous("abc")]}
        onApply={async () => ({
          subscribed: [],
          ignored: [],
          failed: [],
          remaining_ambiguous: []
        })}
      />
    );
    const apply = screen.getByRole("button", { name: /^Apply$/ });
    expect(apply).toBeDisabled();
  });

  it("enables Apply after a selection and submits the correct payload", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn<[
      BootstrapResolution[]
    ], Promise<ApplyResolutionsResult>>(async () => ({
      subscribed: [{ type: "skill", name: "abc", subscription_id: 99 }],
      ignored: [],
      failed: [],
      remaining_ambiguous: []
    }));

    render(
      <ResolveBootstrapDrawer
        open={true}
        onClose={() => {}}
        ambiguous={[makeAmbiguous("abc")]}
        onApply={onApply}
      />
    );

    // Pick repoA.
    await user.click(
      screen.getByRole("radio", { name: /repoA/ })
    );
    await user.click(screen.getByRole("button", { name: /Apply \(1\)/ }));

    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    expect(onApply.mock.calls[0]![0]).toEqual([
      { type: "skill", name: "abc", repo_id: 1 }
    ]);
  });

  it('selecting "Don\'t subscribe" yields repo_id: null', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn(async () => ({
      subscribed: [],
      ignored: [{ type: "skill", name: "abc" }],
      failed: [],
      remaining_ambiguous: []
    }));

    render(
      <ResolveBootstrapDrawer
        open={true}
        onClose={() => {}}
        ambiguous={[makeAmbiguous("abc")]}
        onApply={onApply as never}
      />
    );

    await user.click(
      screen.getByRole("radio", { name: /Don't subscribe/ })
    );
    await user.click(screen.getByRole("button", { name: /Apply \(1\)/ }));

    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    const payload = (onApply.mock.calls[0] as [BootstrapResolution[]])[0];
    expect(payload).toEqual([
      { type: "skill", name: "abc", repo_id: null }
    ]);
  });

  it("auto-closes when remaining_ambiguous becomes empty", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <ResolveBootstrapDrawer
        open={true}
        onClose={onClose}
        ambiguous={[makeAmbiguous("abc")]}
        onApply={async () => ({
          subscribed: [{ type: "skill", name: "abc", subscription_id: 1 }],
          ignored: [],
          failed: [],
          remaining_ambiguous: []
        })}
      />
    );

    await user.click(screen.getByRole("radio", { name: /repoA/ }));
    await user.click(screen.getByRole("button", { name: /Apply \(1\)/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

// ---------- SubscriptionsPanel ----------

function emptyStatus(): GetProjectStatusResponse {
  return {
    project: {
      id: 1,
      name: "demo",
      path: "/tmp/demo",
      primary_tool: ".claude",
      primary_tool_status: "initialized",
      created_at: "2026-04-20T00:00:00Z"
    },
    subscriptions: [],
    linked_dirs: [],
    last_synced: null
  };
}

function emptyBootstrap(): ProjectBootstrapResult {
  return {
    project_id: 1,
    matched: [],
    ambiguous: [],
    unmatched: [],
    scanned_at: "2026-04-21T00:00:00Z"
  };
}

describe("SubscriptionsPanel — v0.5 integration", () => {
  function mount(
    props: Partial<React.ComponentProps<typeof SubscriptionsPanel>> = {}
  ): ReturnType<typeof render> {
    return render(
      <ToastProvider>
        <SubscriptionsPanel
          status={props.status ?? emptyStatus()}
          bootstrap={props.bootstrap ?? emptyBootstrap()}
          projectId={1}
          onUnsubscribe={props.onUnsubscribe ?? vi.fn()}
          onBrowse={props.onBrowse ?? vi.fn()}
          onRescan={props.onRescan}
          onBootstrapResolve={props.onBootstrapResolve}
        />
      </ToastProvider>
    );
  }

  it("renders the banner when bootstrap.ambiguous.length > 0", () => {
    mount({
      bootstrap: {
        ...emptyBootstrap(),
        ambiguous: [makeAmbiguous("abc")]
      }
    });
    expect(
      screen.getByText(/1 ambiguous local skill$/i)
    ).toBeInTheDocument();
    // Banner's button must be "Pick repo", not "Resolve" — this is the
    // guard against regressing into the old copy that collided with the
    // table row's per-conflict [Resolve] button.
    expect(
      screen.getByRole("button", { name: /Pick repo \(1\)/ })
    ).toBeInTheDocument();
  });

  it("shows the v0.7 unmatched banner when unmatched>0 (regardless of subs count)", () => {
    mount({
      bootstrap: {
        ...emptyBootstrap(),
        unmatched: [
          { type: "skill", name: "foo", local_path: "skills/foo" },
          { type: "skill", name: "bar", local_path: "skills/bar" }
        ]
      }
    });
    // v0.7 (spec §1.18): copy routes the user to the Local Skills tab
    // rather than the old "Browse repos" nudge.
    expect(
      screen.getByText(/2 local skills not subscribed/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Local Skills tab/i })
    ).toBeInTheDocument();
  });

  it("[Re-scan local] button invokes onRescan", async () => {
    const user = userEvent.setup();
    const onRescan = vi.fn(async () => {});
    mount({ onRescan });
    await user.click(screen.getByRole("button", { name: /Re-scan local/i }));
    await waitFor(() => expect(onRescan).toHaveBeenCalledOnce());
  });

  it("omits the Re-scan button when onRescan is not provided", () => {
    mount();
    expect(
      screen.queryByRole("button", { name: /Re-scan local/i })
    ).not.toBeInTheDocument();
  });

  it("splits subscriptions into Skills / Commands / Agents groups with correct badges", () => {
    const status: GetProjectStatusResponse = {
      ...emptyStatus(),
      subscriptions: [
        {
          skill: {
            id: 1,
            repo_id: 1,
            type: "skill",
            name: "code-simplifier",
            path: "skills/code-simplifier",
            description: null,
            version: "abc1234",
            updated_at: null
          },
          repo: {
            id: 1,
            name: "astack-skills",
            git_url: "x",
            kind: "custom",
            status: "ready",
            scan_config: null,
            local_path: "/tmp/r",
            head_hash: "abc1234",
            last_synced: null,
            created_at: "2026-04-20T00:00:00Z"
          },
          state: "synced"
        },
        {
          skill: {
            id: 2,
            repo_id: 1,
            type: "command",
            name: "init_harness",
            path: "commands/init_harness.md",
            description: null,
            version: "abc1234",
            updated_at: null
          },
          repo: {
            id: 1,
            name: "astack-skills",
            git_url: "x",
            kind: "custom",
            status: "ready",
            scan_config: null,
            local_path: "/tmp/r",
            head_hash: "abc1234",
            last_synced: null,
            created_at: "2026-04-20T00:00:00Z"
          },
          state: "synced"
        },
        {
          skill: {
            id: 3,
            repo_id: 1,
            type: "agent",
            name: "reviewer",
            path: "agents/reviewer.md",
            description: null,
            version: "abc1234",
            updated_at: null
          },
          repo: {
            id: 1,
            name: "astack-skills",
            git_url: "x",
            kind: "custom",
            status: "ready",
            scan_config: null,
            local_path: "/tmp/r",
            head_hash: "abc1234",
            last_synced: null,
            created_at: "2026-04-20T00:00:00Z"
          },
          state: "synced"
        }
      ]
    };
    mount({ status });

    // Three group headings (regression guard against single-table regression).
    const skillsGroup = screen.getByRole("region", { name: "Skills" });
    const commandsGroup = screen.getByRole("region", { name: "Commands" });
    const agentsGroup = screen.getByRole("region", { name: "Agents" });

    // Each group owns exactly its own rows.
    expect(within(skillsGroup).getByText("code-simplifier")).toBeInTheDocument();
    expect(within(commandsGroup).getByText("init_harness")).toBeInTheDocument();
    expect(within(agentsGroup).getByText("reviewer")).toBeInTheDocument();

    // Badges are type-specific so rows stay self-identifying.
    expect(within(skillsGroup).getByText("dir")).toBeInTheDocument();
    expect(within(commandsGroup).getByText("cmd")).toBeInTheDocument();
    expect(within(agentsGroup).getByText("agent")).toBeInTheDocument();

    // Critical anti-regression: `init_harness` must NOT appear in the Skills
    // group. That was the exact bug the v0.7 grouping fix is solving.
    expect(within(skillsGroup).queryByText("init_harness")).not.toBeInTheDocument();
  });

  it("omits empty groups (no empty Commands / Agents tables shown)", () => {
    const status: GetProjectStatusResponse = {
      ...emptyStatus(),
      subscriptions: [
        {
          skill: {
            id: 1,
            repo_id: 1,
            type: "skill",
            name: "only-one",
            path: "skills/only-one",
            description: null,
            version: "abc1234",
            updated_at: null
          },
          repo: {
            id: 1,
            name: "astack-skills",
            git_url: "x",
            kind: "custom",
            status: "ready",
            scan_config: null,
            local_path: "/tmp/r",
            head_hash: "abc1234",
            last_synced: null,
            created_at: "2026-04-20T00:00:00Z"
          },
          state: "synced"
        }
      ]
    };
    mount({ status });

    expect(screen.getByRole("region", { name: "Skills" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Commands" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Agents" })).not.toBeInTheDocument();
  });

  it("keeps the within import referenced (parity with other test suites)", () => {
    void within;
  });
});
