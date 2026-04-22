/**
 * Tests for AstackClient.
 *
 * Uses a mock fetch to verify:
 *   - method/URL/body serialization per endpoint
 *   - error body rehydration to AstackError
 *   - network failure mapping to SERVER_UNREACHABLE
 */

import { AstackError, ErrorCode } from "@astack/shared";
import { describe, expect, it, vi } from "vitest";

import { AstackClient } from "../src/client.js";

/** Build a mock fetch that returns the given body with status 200. */
function okFetch<T>(body: T, capture?: { method?: string; url?: string }): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (capture) {
      capture.url = typeof url === "string" ? url : url.toString();
      capture.method = init?.method ?? "GET";
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
}

describe("AstackClient", () => {
  const baseUrl = "http://127.0.0.1:7432";

  it("health returns the JSON body", async () => {
    const fetchImpl = okFetch({
      status: "ok",
      version: "1.0.3",
      uptime_ms: 123
    });
    const client = new AstackClient({ baseUrl, fetchImpl });
    const res = await client.health();
    expect(res.status).toBe("ok");
  });

  it("listRepos sends query params correctly", async () => {
    const cap: { method?: string; url?: string } = {};
    const fetchImpl = okFetch({ repos: [], total: 0 }, cap);
    const client = new AstackClient({ baseUrl, fetchImpl });
    await client.listRepos({ offset: 5, limit: 10 });
    expect(cap.method).toBe("GET");
    expect(cap.url).toBe(`${baseUrl}/api/repos?offset=5&limit=10`);
  });

  it("listRepos with no query produces bare URL", async () => {
    const cap: { method?: string; url?: string } = {};
    const fetchImpl = okFetch({ repos: [], total: 0 }, cap);
    const client = new AstackClient({ baseUrl, fetchImpl });
    await client.listRepos();
    expect(cap.url).toBe(`${baseUrl}/api/repos`);
  });

  it("registerRepo sends POST with JSON body", async () => {
    const calls: { init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init });
      return new Response(
        JSON.stringify({
          repo: {
            id: 1,
            name: "x",
            git_url: "g",
            kind: "custom",
            local_path: null,
            head_hash: null,
            last_synced: null,
            created_at: "2026-04-19T00:00:00.000Z"
          },
          skills: [],
          command_count: 0,
          skill_count: 0
        }),
        { status: 201 }
      );
    }) as unknown as typeof fetch;
    const client = new AstackClient({ baseUrl, fetchImpl });
    await client.registerRepo({ git_url: "git@example:x.git" });
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      git_url: "git@example:x.git"
    });
    expect(
      (calls[0]!.init!.headers as Record<string, string>)["content-type"]
    ).toBe("application/json");
  });

  it("rehydrates AstackError from server error body", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          code: "REPO_ALREADY_REGISTERED",
          message: "already registered",
          details: { git_url: "x" }
        }),
        { status: 409 }
      );
    }) as unknown as typeof fetch;
    const client = new AstackClient({ baseUrl, fetchImpl });
    await expect(
      client.registerRepo({ git_url: "x" })
    ).rejects.toMatchObject({
      code: ErrorCode.REPO_ALREADY_REGISTERED
    });
  });

  it("falls back to INTERNAL when error body is not AstackErrorBody-shaped", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ something: "else" }), { status: 500 });
    }) as unknown as typeof fetch;
    const client = new AstackClient({ baseUrl, fetchImpl });
    await expect(client.health()).rejects.toMatchObject({
      code: ErrorCode.INTERNAL
    });
  });

  it("maps fetch network errors to SERVER_UNREACHABLE", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const client = new AstackClient({ baseUrl, fetchImpl });
    await expect(client.health()).rejects.toMatchObject({
      code: ErrorCode.SERVER_UNREACHABLE
    });
  });

  it("strips trailing slash from baseUrl", async () => {
    const cap: { method?: string; url?: string } = {};
    const fetchImpl = okFetch({ status: "ok", version: "1.0.3", uptime_ms: 0 }, cap);
    const client = new AstackClient({ baseUrl: `${baseUrl}/`, fetchImpl });
    await client.health();
    expect(cap.url).toBe(`${baseUrl}/health`);
  });

  it("deleteLinkedDir URL-encodes the tool name", async () => {
    const cap: { method?: string; url?: string } = {};
    const fetchImpl = okFetch(
      { deleted: true, tool_name: "cursor" } as const,
      cap
    );
    const client = new AstackClient({ baseUrl, fetchImpl });
    await client.deleteLinkedDir(1, "weird/name");
    expect(cap.url).toContain("weird%2Fname");
    expect(cap.method).toBe("DELETE");
  });

  it("raises on unknown AstackErrorBody field shapes", async () => {
    const fetchImpl = vi.fn(async () => {
      // missing 'code'
      return new Response(JSON.stringify({ message: "hi" }), { status: 400 });
    }) as unknown as typeof fetch;
    const client = new AstackClient({ baseUrl, fetchImpl });
    await expect(client.health()).rejects.toBeInstanceOf(AstackError);
  });

  // ---------- Method coverage smoke tests ----------

  describe("method smoke (covers every typed helper)", () => {
    function smokeFetch(capture: { method?: string; url?: string } = {}) {
      return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        capture.url = typeof url === "string" ? url : url.toString();
        capture.method = init?.method ?? "GET";
        // Return a permissive success body; we only assert URL/method.
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;
    }

    it("listProjects hits /api/projects", async () => {
      const cap: { method?: string; url?: string } = {};
      const client = new AstackClient({ baseUrl, fetchImpl: smokeFetch(cap) });
      await client.listProjects({ limit: 5 });
      expect(cap.url).toContain("/api/projects?limit=5");
      expect(cap.method).toBe("GET");
    });

    it("registerProject posts to /api/projects", async () => {
      const cap: { method?: string; url?: string } = {};
      const client = new AstackClient({ baseUrl, fetchImpl: smokeFetch(cap) });
      await client.registerProject({ path: "/abs" });
      expect(cap.method).toBe("POST");
      expect(cap.url).toBe(`${baseUrl}/api/projects`);
    });

    it("deleteProject and deleteRepo use DELETE", async () => {
      const cap: { method?: string; url?: string } = {};
      const client = new AstackClient({ baseUrl, fetchImpl: smokeFetch(cap) });
      await client.deleteProject(1);
      expect(cap.method).toBe("DELETE");
      await client.deleteRepo(2);
      expect(cap.url).toBe(`${baseUrl}/api/repos/2`);
    });

    it("refreshRepo POSTs to /:id/refresh", async () => {
      const cap: { method?: string; url?: string } = {};
      const client = new AstackClient({ baseUrl, fetchImpl: smokeFetch(cap) });
      await client.refreshRepo(3);
      expect(cap.method).toBe("POST");
      expect(cap.url).toBe(`${baseUrl}/api/repos/3/refresh`);
    });

    it("listRepoSkills GETs the skills collection", async () => {
      const cap: { method?: string; url?: string } = {};
      const client = new AstackClient({ baseUrl, fetchImpl: smokeFetch(cap) });
      await client.listRepoSkills(4);
      expect(cap.url).toBe(`${baseUrl}/api/repos/4/skills`);
    });

    it("projectStatus and skillDiff hit the right URLs", async () => {
      const cap: { method?: string; url?: string } = {};
      const client = new AstackClient({ baseUrl, fetchImpl: smokeFetch(cap) });
      await client.projectStatus(5);
      expect(cap.url).toBe(`${baseUrl}/api/projects/5/status`);
      await client.skillDiff(5, 9);
      expect(cap.url).toBe(`${baseUrl}/api/projects/5/diff/9`);
    });

    it("unsubscribe uses DELETE on nested path", async () => {
      const cap: { method?: string; url?: string } = {};
      const client = new AstackClient({ baseUrl, fetchImpl: smokeFetch(cap) });
      await client.unsubscribe(1, 2);
      expect(cap.method).toBe("DELETE");
      expect(cap.url).toBe(`${baseUrl}/api/projects/1/subscriptions/2`);
    });

    it("sync and push POST", async () => {
      const cap: { method?: string; url?: string } = {};
      const client = new AstackClient({ baseUrl, fetchImpl: smokeFetch(cap) });
      await client.sync(1);
      expect(cap.url).toBe(`${baseUrl}/api/projects/1/sync`);
      await client.push(1);
      expect(cap.url).toBe(`${baseUrl}/api/projects/1/push`);
    });

    it("createLinkedDir POSTs to /links", async () => {
      const cap: { method?: string; url?: string } = {};
      const client = new AstackClient({ baseUrl, fetchImpl: smokeFetch(cap) });
      await client.createLinkedDir(1, { tool_name: "cursor" });
      expect(cap.method).toBe("POST");
      expect(cap.url).toBe(`${baseUrl}/api/projects/1/links`);
    });

    it("resolve POSTs to /resolve", async () => {
      const cap: { method?: string; url?: string } = {};
      const client = new AstackClient({ baseUrl, fetchImpl: smokeFetch(cap) });
      await client.resolve(1, {
        skill_id: 2,
        strategy: "use-remote",
        manual_done: false
      });
      expect(cap.url).toBe(`${baseUrl}/api/projects/1/resolve`);
    });
  });
});
