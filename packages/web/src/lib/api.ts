/**
 * API client for the dashboard.
 *
 * Mirrors packages/cli/src/client.ts but uses browser fetch + same-origin
 * URLs (the dashboard is served from the daemon in production; Vite
 * proxies in dev). Strongly typed via @astack/shared schemas.
 *
 * No dependency on CLI; duplicating this small layer avoids pulling a
 * node-flavored module into the browser bundle.
 */

import {
  AstackError,
  ErrorCode,
  type AstackErrorBody,
  type CreateToolLinkRequest,
  type CreateToolLinkResponse,
  type DeleteProjectResponse,
  type DeleteRepoResponse,
  type DeleteToolLinkResponse,
  type GetProjectStatusResponse,
  type ListProjectsResponse,
  type ListRepoSkillsResponse,
  type ListReposResponse,
  type PushResponse,
  type RefreshRepoResponse,
  type RegisterProjectRequest,
  type RegisterProjectResponse,
  type RegisterRepoRequest,
  type RegisterRepoResponse,
  type ResolveRequest,
  type ResolveResponse,
  type SubscribeRequest,
  type SubscribeResponse,
  type SyncResponse,
  type UnsubscribeResponse
} from "@astack/shared";

export interface HealthResponse {
  status: string;
  version: string;
  uptime_ms: number;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    throw new AstackError(
      ErrorCode.SERVER_UNREACHABLE,
      "Could not reach astack server. Run: astack server start",
      { error: err instanceof Error ? err.message : String(err) }
    );
  }

  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : undefined;

  if (!res.ok) {
    if (isAstackErrorBody(parsed)) {
      throw AstackError.fromJSON(parsed);
    }
    throw new AstackError(
      ErrorCode.INTERNAL,
      `HTTP ${res.status} on ${method} ${path}`,
      { body: parsed }
    );
  }

  return parsed as T;
}

function isAstackErrorBody(v: unknown): v is AstackErrorBody {
  return (
    typeof v === "object" &&
    v !== null &&
    "code" in v &&
    "message" in v &&
    typeof (v as { code: unknown }).code === "string"
  );
}

function qs(q: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

// ---------- API surface ----------

export const api = {
  // Health
  health: (): Promise<HealthResponse> => request("GET", "/health"),

  // Repos
  listRepos: (q: { offset?: number; limit?: number } = {}): Promise<ListReposResponse> =>
    request("GET", `/api/repos${qs(q)}`),
  registerRepo: (body: RegisterRepoRequest): Promise<RegisterRepoResponse> =>
    request("POST", "/api/repos", body),
  deleteRepo: (id: number): Promise<DeleteRepoResponse> =>
    request("DELETE", `/api/repos/${id}`),
  refreshRepo: (id: number): Promise<RefreshRepoResponse> =>
    request("POST", `/api/repos/${id}/refresh`),
  listRepoSkills: (id: number): Promise<ListRepoSkillsResponse> =>
    request("GET", `/api/repos/${id}/skills`),

  // Projects
  listProjects: (
    q: { offset?: number; limit?: number } = {}
  ): Promise<ListProjectsResponse> =>
    request("GET", `/api/projects${qs(q)}`),
  registerProject: (body: RegisterProjectRequest): Promise<RegisterProjectResponse> =>
    request("POST", "/api/projects", body),
  deleteProject: (id: number): Promise<DeleteProjectResponse> =>
    request("DELETE", `/api/projects/${id}`),
  projectStatus: (id: number): Promise<GetProjectStatusResponse> =>
    request("GET", `/api/projects/${id}/status`),

  // Subscriptions / sync / push / resolve
  subscribe: (
    projectId: number,
    body: SubscribeRequest
  ): Promise<SubscribeResponse> =>
    request("POST", `/api/projects/${projectId}/subscriptions`, body),
  unsubscribe: (
    projectId: number,
    skillId: number
  ): Promise<UnsubscribeResponse> =>
    request(
      "DELETE",
      `/api/projects/${projectId}/subscriptions/${skillId}`
    ),
  sync: (projectId: number, force = false): Promise<SyncResponse> =>
    request("POST", `/api/projects/${projectId}/sync`, { force }),
  push: (projectId: number): Promise<PushResponse> =>
    request("POST", `/api/projects/${projectId}/push`, {}),
  resolve: (
    projectId: number,
    body: ResolveRequest
  ): Promise<ResolveResponse> =>
    request("POST", `/api/projects/${projectId}/resolve`, body),

  // Tool links
  createToolLink: (
    projectId: number,
    body: CreateToolLinkRequest
  ): Promise<CreateToolLinkResponse> =>
    request("POST", `/api/projects/${projectId}/links`, body),
  deleteToolLink: (
    projectId: number,
    tool: string
  ): Promise<DeleteToolLinkResponse> =>
    request(
      "DELETE",
      `/api/projects/${projectId}/links/${encodeURIComponent(tool)}`
    )
};

export { AstackError, ErrorCode };
