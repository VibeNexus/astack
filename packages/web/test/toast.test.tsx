/**
 * Toast provider tests.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ToastProvider, useToast } from "../src/lib/toast.js";

function TestHarness({
  onReady
}: {
  onReady: (api: ReturnType<typeof useToast>) => void;
}): null {
  const toast = useToast();
  onReady(toast);
  return null;
}

describe("ToastProvider", () => {
  it("renders an ok toast that auto-dismisses after 3s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let api!: ReturnType<typeof useToast>;
    render(
      <ToastProvider>
        <TestHarness onReady={(a) => (api = a)} />
      </ToastProvider>
    );
    act(() => api.ok("Saved"));
    expect(screen.getByText("Saved")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_001);
    });
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("error toasts auto-dismiss after 10s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let api!: ReturnType<typeof useToast>;
    render(
      <ToastProvider>
        <TestHarness onReady={(a) => (api = a)} />
      </ToastProvider>
    );
    act(() => api.error("Boom", "details"));
    expect(screen.getByText("Boom")).toBeInTheDocument();
    expect(screen.getByText("details")).toBeInTheDocument();

    // Still visible at 3s (ok/warn dismiss window) — errors get a longer fuse.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_001);
    });
    expect(screen.getByText("Boom")).toBeInTheDocument();

    // Gone after 10s total.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_100);
    });
    expect(screen.queryByText("Boom")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("error toasts can be dismissed via the close button", async () => {
    let api!: ReturnType<typeof useToast>;
    render(
      <ToastProvider>
        <TestHarness onReady={(a) => (api = a)} />
      </ToastProvider>
    );
    act(() => api.error("Boom", "details"));
    expect(screen.getByText("Boom")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    await waitFor(() => {
      expect(screen.queryByText("Boom")).not.toBeInTheDocument();
    });
  });

  it("error toasts can still be dismissed by clicking the body", async () => {
    let api!: ReturnType<typeof useToast>;
    render(
      <ToastProvider>
        <TestHarness onReady={(a) => (api = a)} />
      </ToastProvider>
    );
    act(() => api.error("Boom"));
    expect(screen.getByText("Boom")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Boom"));
    await waitFor(() => {
      expect(screen.queryByText("Boom")).not.toBeInTheDocument();
    });
  });

  it("warn emits a warn toast", () => {
    let api!: ReturnType<typeof useToast>;
    render(
      <ToastProvider>
        <TestHarness onReady={(a) => (api = a)} />
      </ToastProvider>
    );
    act(() => api.warn("Mind the gap"));
    expect(screen.getByText("Mind the gap")).toBeInTheDocument();
  });

  it("throws when used outside provider", () => {
    function Bad(): null {
      useToast();
      return null;
    }
    // Suppress React's error boundary noise.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Bad />)).toThrow(/useToast must be used inside/);
    spy.mockRestore();
  });
});
