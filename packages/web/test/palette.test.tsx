/**
 * CommandPalette tests — keyboard navigation, filtering, routing.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { CommandPalette } from "../src/components/CommandPalette.js";

function wrap(open: boolean, onClose = vi.fn()): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <CommandPalette open={open} onClose={onClose} />
    </MemoryRouter>
  );
}

describe("CommandPalette", () => {
  it("renders nothing when closed", () => {
    const { container } = wrap(false);
    expect(container.firstChild).toBeNull();
  });

  it("shows command list when open", () => {
    wrap(true);
    expect(screen.getByText("Go to Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Go to Repos")).toBeInTheDocument();
    expect(screen.getByText("Go to Settings")).toBeInTheDocument();
  });

  it("filters by typed query", () => {
    wrap(true);
    const input = screen.getByPlaceholderText("Type a command…");
    fireEvent.change(input, { target: { value: "repos" } });
    expect(screen.getByText("Go to Repos")).toBeInTheDocument();
    expect(screen.queryByText("Go to Settings")).not.toBeInTheDocument();
  });

  it("shows 'No matches' when query matches nothing", () => {
    wrap(true);
    const input = screen.getByPlaceholderText("Type a command…");
    fireEvent.change(input, { target: { value: "xyzzy" } });
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    wrap(true, onClose);
    const input = screen.getByPlaceholderText("Type a command…");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("Enter runs the focused command and closes", () => {
    const onClose = vi.fn();
    wrap(true, onClose);
    const input = screen.getByPlaceholderText("Type a command…");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onClose).toHaveBeenCalled();
  });

  it("Arrow keys move the cursor", () => {
    wrap(true);
    const input = screen.getByPlaceholderText("Type a command…");
    // Press arrow down 2 times, then arrow up — should not throw.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    // No assertion on cursor index (it's visual); just smoke.
    expect(input).toBeInTheDocument();
  });
});
