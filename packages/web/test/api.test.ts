/**
 * Tests for the dashboard API client.
 *
 * Uses a mock global fetch. Verifies URL/method per endpoint + error
 * rehydration to AstackError.
 */

import { AstackError, ErrorCode } from "@astack/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../src/lib/api.js";

type FetchCall = { url: string; method: string; body?: string };

function mockFetch(
  handler: (call: FetchCall) => { status: number; body: unknown }
): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: FetchCall = {
        url: typeof input === "string" ? input : input.toString(),
        method: init?.method ?? "GET",
        body: init?.body ? String(init.body) : undefined
      };
      calls.push(call);
      const res = handler(call);
      return new Response(
        res.body == null ? "" : JSON.stringify(res.body),
        { status: res.status }
      );
    }
  ) as typeof fetch;
  return calls;
}

describe("api client", () => {
  let origFetch: typeof fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("GET /health", async () => {
    const calls = mockFetch(() => ({
      status: 200,
      body: { status: "ok", version: "0.1.0", uptime_ms: 10 }
    }));
    const h = await api.health();
    expect(h.status).toBe("ok");
    expect(calls[0]!.url).toBe("/health");
    expect(calls[0]!.method).toBe("GET");
  });

  it("POST /api/repos", async () => {
    const calls = mockFetch(() => ({
      status: 201,
      body: {
        repo: {
          id: 1,
          name: "r",
          git_url: "g",
          local_path: null,
          head_hash: null,
          last_synced: null,
          created_at: "2026-04-19T00:00:00.000Z"
        },
        skills: [],
        command_count: 0,
        skill_count: 0
      }
    }));
    await api.registerRepo({ git_url: "git@x:y.git" });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("/api/repos");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ git_url: "git@x:y.git" });
  });

  it("rehydrates server errors into AstackError", async () => {
    mockFetch(() => ({
      status: 409,
      body: {
        code: "REPO_ALREADY_REGISTERED",
        message: "already",
        details: { git_url: "x" }
      }
    }));
    await expect(api.registerRepo({ git_url: "x" })).rejects.toMatchObject({
      code: ErrorCode.REPO_ALREADY_REGISTERED
    });
  });

  it("maps fetch network failure to SERVER_UNREACHABLE", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("failed");
    }) as typeof fetch;
    await expect(api.health()).rejects.toBeInstanceOf(AstackError);
    await expect(api.health()).rejects.toMatchObject({
      code: ErrorCode.SERVER_UNREACHABLE
    });
  });

  it("covers listProjects/deleteProject/projectStatus URLs", async () => {
    const calls = mockFetch(() => ({ status: 200, body: {} }));
    await api.listProjects({ limit: 20 });
    await api.deleteProject(5);
    await api.projectStatus(7);
    expect(calls[0]!.url).toBe("/api/projects?limit=20");
    expect(calls[1]!.method).toBe("DELETE");
    expect(calls[1]!.url).toBe("/api/projects/5");
    expect(calls[2]!.url).toBe("/api/projects/7/status");
  });

  it("covers subscribe/sync/push/resolve", async () => {
    const calls = mockFetch(() => ({ status: 200, body: {} }));
    await api.subscribe(1, { skills: ["x"], sync_now: true });
    await api.sync(1);
    await api.push(1);
    await api.resolve(1, {
      skill_id: 1,
      strategy: "use-remote",
      manual_done: false
    });
    expect(calls.map((c) => c.url)).toEqual([
      "/api/projects/1/subscriptions",
      "/api/projects/1/sync",
      "/api/projects/1/push",
      "/api/projects/1/resolve"
    ]);
  });

  it("URL-encodes deleteToolLink tool name", async () => {
    const calls = mockFetch(() => ({ status: 200, body: {} }));
    await api.deleteToolLink(1, "weird/name");
    expect(calls[0]!.url).toBe("/api/projects/1/links/weird%2Fname");
    expect(calls[0]!.method).toBe("DELETE");
  });

  it("createToolLink, unsubscribe, refreshRepo, deleteRepo, listRepos", async () => {
    const calls = mockFetch(() => ({ status: 200, body: {} }));
    await api.createToolLink(1, { tool_name: "cursor" });
    await api.unsubscribe(1, 2);
    await api.refreshRepo(3);
    await api.deleteRepo(4);
    await api.listRepos();
    expect(calls.map((c) => c.url)).toEqual([
      "/api/projects/1/links",
      "/api/projects/1/subscriptions/2",
      "/api/repos/3/refresh",
      "/api/repos/4",
      "/api/repos"
    ]);
  });

  it("registerProject POST", async () => {
    const calls = mockFetch(() => ({ status: 201, body: {} }));
    await api.registerProject({ path: "/abs" });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("/api/projects");
  });
});
