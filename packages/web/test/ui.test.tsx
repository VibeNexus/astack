/**
 * UI component smoke tests.
 *
 * Renders primitives via testing-library and asserts the essentials
 * (aria/role, class output, click handling). These are dumb components;
 * the assertions are mostly against design decisions 4 / 5.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  Kbd,
  Skeleton,
  StatusDot
} from "../src/components/ui.js";

describe("Button", () => {
  it("renders children and fires onClick", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    fireEvent.click(screen.getByText("Save"));
    expect(onClick).toHaveBeenCalled();
  });

  it("primary variant uses the accent background", () => {
    render(<Button variant="primary">Go</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("bg-accent");
  });

  it("ghost variant has transparent background", () => {
    render(<Button variant="ghost">Go</Button>);
    expect(screen.getByRole("button").className).toContain("bg-transparent");
  });

  it("honors disabled", () => {
    render(<Button disabled>No</Button>);
    expect(screen.getByRole("button")).toBeDisabled();
  });
});

describe("Badge", () => {
  it("renders children with tone classes", () => {
    const { rerender } = render(<Badge tone="accent">ok</Badge>);
    expect(screen.getByText("ok").className).toContain("text-accent");
    rerender(<Badge tone="error">fail</Badge>);
    expect(screen.getByText("fail").className).toContain("text-error");
  });
});

describe("StatusDot", () => {
  it("renders a dot span with color by tone", () => {
    const { container, rerender } = render(<StatusDot tone="accent" />);
    expect(container.querySelector(".bg-accent")).toBeInTheDocument();
    rerender(<StatusDot tone="error" />);
    expect(container.querySelector(".bg-error")).toBeInTheDocument();
  });
});

describe("Card + EmptyState + Skeleton + Kbd", () => {
  it("Card wraps children with surface classes", () => {
    render(
      <Card>
        <div>content</div>
      </Card>
    );
    expect(screen.getByText("content")).toBeInTheDocument();
  });

  it("EmptyState shows title and hint", () => {
    render(
      <EmptyState title="Empty" hint="Do a thing">
        <div>cta</div>
      </EmptyState>
    );
    expect(screen.getByText("Empty")).toBeInTheDocument();
    expect(screen.getByText("Do a thing")).toBeInTheDocument();
    expect(screen.getByText("cta")).toBeInTheDocument();
  });

  it("Skeleton is aria-hidden", () => {
    const { container } = render(<Skeleton className="h-10" />);
    const skel = container.querySelector('[aria-hidden="true"]');
    expect(skel).not.toBeNull();
  });

  it("Kbd renders a kbd element", () => {
    const { container } = render(<Kbd>⌘K</Kbd>);
    expect(container.querySelector("kbd")).toBeInTheDocument();
    expect(screen.getByText("⌘K")).toBeInTheDocument();
  });
});
