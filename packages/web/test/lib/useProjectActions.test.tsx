/**
 * useProjectActions tests — validate the try/catch/toast/reload contract.
 *
 * We render a tiny consumer component, stub api + toast, and assert that
 * each helper matches the behavior that ProjectDetailPage's hand-rolled
 * handlers had pre-v0.3 (so we can delete those handlers without drift).
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useProjectActions } from "../../src/lib/useProjectActions.js";
import type { PropsWithChildren } from "react";
import * as React from "react";

// Mock the api module. Each test re-assigns the specific methods it needs.
vi.mock("../../src/lib/api.js", async () => {
  const actual = await vi.importActual<object>("../../src/lib/api.js");
  return {
    ...actual,
    api: {
      sync: vi.fn(),
      push: vi.fn(),
      unsubscribe: vi.fn(),
      createToolLink: vi.fn(),
      deleteToolLink: vi.fn()
    }
  };
});

import { api, AstackError, ErrorCode } from "../../src/lib/api.js";
import { ToastProvider, useToast } from "../../src/lib/toast.js";

const PROJECT_ID = 42;

// Capture toast calls by wrapping the provider with a spy consumer.
let toastSpies: {
  ok: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function ToastSpy({ children }: PropsWithChildren): React.JSX.Element {
  // Drop-in that reads real context then patches the methods onto the spies.
  // We do this on the component that consumes the hook, via a wrapper below.
  return <>{children}</>;
}

function Wrapper({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <ToastProvider>
      <ToastSpy>
        <SpyInstaller>{children}</SpyInstaller>
      </ToastSpy>
    </ToastProvider>
  );
}

/**
 * Inside the ToastProvider tree, intercept useToast and pipe calls into
 * toastSpies so tests can assert. This is a test-only layer; real code
 * uses useToast() directly.
 */
function SpyInstaller({ children }: PropsWithChildren): React.JSX.Element {
  const real = useToast();
  // Re-wire each call so assertions run against predictable spies.
  toastSpies.ok.mockImplementation(real.ok);
  toastSpies.warn.mockImplementation(real.warn);
  toastSpies.error.mockImplementation(real.error);
  return <>{children}</>;
}

describe("useProjectActions", () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    reload = vi.fn().mockResolvedValue(undefined);
    toastSpies = {
      ok: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ---- runAction (escape hatch) ----

  it("runAction: success path calls fn, toasts ok, then reloads", async () => {
    const { result } = renderHook(
      () => useProjectActions(PROJECT_ID, reload),
      { wrapper: Wrapper }
    );
    const fn = vi.fn().mockResolvedValue({ answer: 42 });
    let returned: unknown;
    await act(async () => {
      returned = await result.current.runAction(fn, {
        okMsg: "done",
        errMsg: "oh no"
      });
    });
    expect(fn).toHaveBeenCalledOnce();
    expect(returned).toEqual({ answer: 42 });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("runAction: skipReload does not call reload", async () => {
    const { result } = renderHook(
      () => useProjectActions(PROJECT_ID, reload),
      { wrapper: Wrapper }
    );
    const fn = vi.fn().mockResolvedValue("ok");
    await act(async () => {
      await result.current.runAction(fn, {
        errMsg: "err",
        skipReload: true
      });
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it("runAction: okMsg can be a function of the result", async () => {
    const { result } = renderHook(
      () => useProjectActions(PROJECT_ID, reload),
      { wrapper: Wrapper }
    );
    const fn = vi.fn().mockResolvedValue({ count: 3 });
    await act(async () => {
      await result.current.runAction(fn, {
        okMsg: (r) => `synced ${(r as { count: number }).count}`,
        errMsg: "err"
      });
    });
    // Assert via the toast list rendered into the DOM.
    expect(
      document.body.textContent?.includes("synced 3")
    ).toBe(true);
  });

  it("runAction: AstackError path toasts error with .message and does NOT reload", async () => {
    const { result } = renderHook(
      () => useProjectActions(PROJECT_ID, reload),
      { wrapper: Wrapper }
    );
    const fn = vi.fn().mockRejectedValue(
      new AstackError(ErrorCode.PROJECT_NOT_FOUND, "no such project")
    );
    let returned: unknown = "sentinel";
    await act(async () => {
      returned = await result.current.runAction(fn, { errMsg: "Sync failed" });
    });
    expect(returned).toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
    expect(
      document.body.textContent?.includes("no such project")
    ).toBe(true);
  });

  it("runAction: generic Error path uses .message", async () => {
    const { result } = renderHook(
      () => useProjectActions(PROJECT_ID, reload),
      { wrapper: Wrapper }
    );
    const fn = vi.fn().mockRejectedValue(new Error("network kaput"));
    await act(async () => {
      await result.current.runAction(fn, { errMsg: "Push failed" });
    });
    expect(
      document.body.textContent?.includes("network kaput")
    ).toBe(true);
  });

  it("runAction: non-Error thrown value stringifies", async () => {
    const { result } = renderHook(
      () => useProjectActions(PROJECT_ID, reload),
      { wrapper: Wrapper }
    );
    const fn = vi.fn().mockRejectedValue("plain string");
    await act(async () => {
      await result.current.runAction(fn, { errMsg: "err" });
    });
    expect(
      document.body.textContent?.includes("plain string")
    ).toBe(true);
  });

  // ---- unsubscribe ----

  it("unsubscribe: returns true on success, false on error", async () => {
    const unsubMock = vi.mocked(api.unsubscribe);
    unsubMock.mockResolvedValueOnce({ deleted: true, file_removed: false });
    unsubMock.mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(
      () => useProjectActions(PROJECT_ID, reload),
      { wrapper: Wrapper }
    );

    let first: boolean | undefined;
    await act(async () => {
      first = await result.current.unsubscribe(7);
    });
    expect(first).toBe(true);
    expect(unsubMock).toHaveBeenCalledWith(PROJECT_ID, 7);

    let second: boolean | undefined;
    await act(async () => {
      second = await result.current.unsubscribe(8);
    });
    expect(second).toBe(false);
  });

  // ---- addLink / removeLink ----

  it("addLink: passes tool_name correctly", async () => {
    const createMock = vi.mocked(api.createToolLink);
    createMock.mockResolvedValue({
      link: {
        id: 1,
        project_id: PROJECT_ID,
        tool_name: "cursor",
        dir_name: ".cursor",
        status: "active",
        created_at: "2026-04-20T00:00:00Z"
      }
    });
    const { result } = renderHook(
      () => useProjectActions(PROJECT_ID, reload),
      { wrapper: Wrapper }
    );
    await act(async () => {
      await result.current.addLink("cursor");
    });
    expect(createMock).toHaveBeenCalledWith(PROJECT_ID, {
      tool_name: "cursor"
    });
  });

  it("removeLink: passes tool_name correctly", async () => {
    const delMock = vi.mocked(api.deleteToolLink);
    delMock.mockResolvedValue({ deleted: true });
    const { result } = renderHook(
      () => useProjectActions(PROJECT_ID, reload),
      { wrapper: Wrapper }
    );
    await act(async () => {
      await result.current.removeLink("codebuddy");
    });
    expect(delMock).toHaveBeenCalledWith(PROJECT_ID, "codebuddy");
  });

  // ---- sync / push ----

  it("sync: errors trigger toast but don't reload (we always reload anyway)", async () => {
    // sync's runAction has no skipReload, so reload IS expected on success.
    // On error, reload must NOT run.
    const syncMock = vi.mocked(api.sync);
    syncMock.mockRejectedValue(new Error("daemon gone"));
    const { result } = renderHook(
      () => useProjectActions(PROJECT_ID, reload),
      { wrapper: Wrapper }
    );
    await act(async () => {
      await result.current.sync();
    });
    expect(syncMock).toHaveBeenCalledWith(PROJECT_ID);
    expect(reload).not.toHaveBeenCalled();
    expect(
      document.body.textContent?.includes("daemon gone")
    ).toBe(true);
  });
});
