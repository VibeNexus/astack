/**
 * Tabs + TabPanel tests.
 *
 * Focus areas:
 *   - WAI-ARIA APG compliance (role, aria-selected, aria-controls)
 *   - Roving tabindex (active=0, others=-1)
 *   - Keyboard: ← / → / Home / End
 *   - Disabled tab skipping on keyboard
 *   - Selection-follows-focus (onChange fires on arrow keys)
 *   - Badge render rules (hide when 0 / undefined, show when positive)
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Tabs, TabPanel, type TabItem } from "../../src/components/ui/Tabs.js";
import { useState } from "react";

const TABS: TabItem[] = [
  { id: "subs", label: "Subscriptions", badge: 12 },
  { id: "tools", label: "Linked Dirs", badge: 3 },
  { id: "history", label: "Sync History" },
  { id: "settings", label: "Settings" }
];

function Harness({
  initial = "subs",
  tabs = TABS,
  onChangeSpy
}: {
  initial?: string;
  tabs?: TabItem[];
  onChangeSpy?: (id: string) => void;
}): React.JSX.Element {
  const [activeId, setActiveId] = useState(initial);
  return (
    <Tabs
      tabs={tabs}
      activeId={activeId}
      onChange={(id) => {
        setActiveId(id);
        onChangeSpy?.(id);
      }}
      aria-label="Project sections"
      idPrefix="test"
    />
  );
}

describe("Tabs", () => {
  it("renders a tablist with the expected tabs", () => {
    render(<Harness />);
    const list = screen.getByRole("tablist", { name: "Project sections" });
    expect(list).toHaveAttribute("aria-orientation", "horizontal");
    expect(screen.getAllByRole("tab")).toHaveLength(4);
  });

  it("sets aria-selected + roving tabindex correctly for the active tab", () => {
    render(<Harness initial="tools" />);
    const subs = screen.getByRole("tab", { name: /Subscriptions/ });
    const tools = screen.getByRole("tab", { name: /Linked Dirs/ });
    expect(tools).toHaveAttribute("aria-selected", "true");
    expect(tools).toHaveAttribute("tabindex", "0");
    expect(subs).toHaveAttribute("aria-selected", "false");
    expect(subs).toHaveAttribute("tabindex", "-1");
  });

  it("renders aria-controls that points at the matching TabPanel id", () => {
    render(
      <>
        <Harness />
        <TabPanel tabId="subs" activeId="subs" idPrefix="test">
          content
        </TabPanel>
      </>
    );
    const subsTab = screen.getByRole("tab", { name: /Subscriptions/ });
    expect(subsTab).toHaveAttribute("aria-controls", "test-panel-subs");
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("id", "test-panel-subs");
    expect(panel).toHaveAttribute("aria-labelledby", "test-tab-subs");
  });

  it("ArrowRight moves selection to the next tab and focuses it", () => {
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} />);
    const list = screen.getByRole("tablist");
    act(() => {
      fireEvent.keyDown(list, { key: "ArrowRight" });
    });
    expect(spy).toHaveBeenLastCalledWith("tools");
    expect(document.activeElement?.textContent).toContain("Linked Dirs");
  });

  it("ArrowLeft on the first tab wraps to the last", () => {
    const spy = vi.fn();
    render(<Harness initial="subs" onChangeSpy={spy} />);
    const list = screen.getByRole("tablist");
    act(() => {
      fireEvent.keyDown(list, { key: "ArrowLeft" });
    });
    expect(spy).toHaveBeenLastCalledWith("settings");
  });

  it("Home jumps to the first tab, End to the last", () => {
    const spy = vi.fn();
    render(<Harness initial="tools" onChangeSpy={spy} />);
    const list = screen.getByRole("tablist");
    act(() => {
      fireEvent.keyDown(list, { key: "End" });
    });
    expect(spy).toHaveBeenLastCalledWith("settings");
    act(() => {
      fireEvent.keyDown(list, { key: "Home" });
    });
    expect(spy).toHaveBeenLastCalledWith("subs");
  });

  it("skips disabled tabs on keyboard nav", () => {
    const tabs: TabItem[] = [
      { id: "a", label: "A" },
      { id: "b", label: "B", disabled: true },
      { id: "c", label: "C" }
    ];
    const spy = vi.fn();
    render(<Harness initial="a" tabs={tabs} onChangeSpy={spy} />);
    const list = screen.getByRole("tablist");
    act(() => {
      fireEvent.keyDown(list, { key: "ArrowRight" });
    });
    // Should skip "b" and land on "c", not stop at the disabled one.
    expect(spy).toHaveBeenLastCalledWith("c");
  });

  it("hides the badge when count is 0 or undefined", () => {
    const tabs: TabItem[] = [
      { id: "x", label: "X", badge: 0 },
      { id: "y", label: "Y" }
    ];
    render(<Harness initial="x" tabs={tabs} />);
    // Badge "0" should NOT be rendered; "Y" has no badge field at all.
    expect(screen.queryByText("0")).toBeNull();
  });

  it("shows the badge when positive", () => {
    render(<Harness />);
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("clicking a disabled tab is a no-op", () => {
    const tabs: TabItem[] = [
      { id: "a", label: "A" },
      { id: "b", label: "B", disabled: true }
    ];
    const spy = vi.fn();
    render(<Harness initial="a" tabs={tabs} onChangeSpy={spy} />);
    const disabled = screen.getByRole("tab", { name: "B" });
    act(() => {
      fireEvent.click(disabled);
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("TabPanel", () => {
  it("unmounts inactive panels by default", () => {
    render(
      <>
        <TabPanel tabId="subs" activeId="tools" idPrefix="t">
          subs panel
        </TabPanel>
        <TabPanel tabId="tools" activeId="tools" idPrefix="t">
          tools panel
        </TabPanel>
      </>
    );
    expect(screen.queryByText("subs panel")).toBeNull();
    expect(screen.getByText("tools panel")).toBeInTheDocument();
  });

  it("keeps inactive panel mounted with hidden=true when keepMounted", () => {
    render(
      <TabPanel
        tabId="subs"
        activeId="tools"
        idPrefix="t"
        keepMounted
      >
        hidden subs
      </TabPanel>
    );
    const panel = screen.getByText("hidden subs").closest("[role='tabpanel']");
    expect(panel).toHaveAttribute("hidden");
  });
});
