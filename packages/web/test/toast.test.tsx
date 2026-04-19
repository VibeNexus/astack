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

  it("error toasts stay until clicked", async () => {
    let api!: ReturnType<typeof useToast>;
    render(
      <ToastProvider>
        <TestHarness onReady={(a) => (api = a)} />
      </ToastProvider>
    );
    act(() => api.error("Boom", "details"));
    expect(screen.getByText("Boom")).toBeInTheDocument();
    expect(screen.getByText("details")).toBeInTheDocument();

    // Wait 100ms real-time to ensure no auto-dismiss fires.
    await new Promise((r) => setTimeout(r, 100));
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
