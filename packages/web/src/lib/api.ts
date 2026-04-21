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
  type ApplyResolutionsResult,
  type AstackErrorBody,
  type BootstrapResolution,
  type CreateLinkedDirRequest,
  type CreateLinkedDirResponse,
  type DeleteProjectResponse,
  type DeleteRepoResponse,
  type DeleteLinkedDirResponse,
  type GetProjectStatusResponse,
  type ListProjectsResponse,
  type ListRepoSkillsResponse,
  type ListReposResponse,
  type ListSyncLogsQuery,
  type ListSyncLogsResponse,
  type FsListResponse,
  type ProjectBootstrapResult,
  type ProjectHarnessState,
  type PushResponse,
  type RefreshRepoResponse,
  type RegisterProjectRequest,
  type RegisterProjectResponse,
  type RegisterRepoRequest,
  type RegisterRepoResponse,
  type ResolveRequest,
  type ResolveResponse,
  type ScanAndAutoSubscribeResult,
  type SkillType,
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

  // Sync history feed (v0.3). Powers the Sync History tab.
  listSyncLogs: (
    projectId: number,
    q: ListSyncLogsQuery | Record<string, never> = {}
  ): Promise<ListSyncLogsResponse> => {
    // ListSyncLogsQuery has optional fields + numeric defaults; pass
    // through only defined keys to keep the URL clean.
    const params: Record<string, string> = {};
    const src = q as Partial<ListSyncLogsQuery>;
    if (src.limit !== undefined) params.limit = String(src.limit);
    if (src.offset !== undefined) params.offset = String(src.offset);
    if (src.skill_id !== undefined) params.skill_id = String(src.skill_id);
    if (src.direction !== undefined) params.direction = src.direction;
    if (src.status !== undefined) params.status = src.status;
    return request("GET", `/api/projects/${projectId}/sync-logs${qs(params)}`);
  },

  // Filesystem navigation (powers path autocomplete in Register Project).
  fsList: (
    q: { path?: string; show_hidden?: boolean } = {}
  ): Promise<FsListResponse> => {
    const params: Record<string, string> = {};
    if (q.path !== undefined) params.path = q.path;
    if (q.show_hidden) params.show_hidden = "1";
    return request("GET", `/api/fs/list${qs(params)}`);
  },

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

  // Linked dirs
  createLinkedDir: (
    projectId: number,
    body: CreateLinkedDirRequest
  ): Promise<CreateLinkedDirResponse> =>
    request("POST", `/api/projects/${projectId}/links`, body),
  deleteLinkedDir: (
    projectId: number,
    tool: string
  ): Promise<DeleteLinkedDirResponse> =>
    request(
      "DELETE",
      `/api/projects/${projectId}/links/${encodeURIComponent(tool)}`
    ),

  // Harness (v0.4 — system-skill installation state)
  inspectHarness: (projectId: number): Promise<ProjectHarnessState> =>
    request("GET", `/api/projects/${projectId}/harness`),
  installHarness: (projectId: number): Promise<ProjectHarnessState> =>
    request("POST", `/api/projects/${projectId}/harness/install`),

  // Bootstrap (v0.5 — auto-subscribe legacy .claude/ contents)
  inspectBootstrap: (projectId: number): Promise<ProjectBootstrapResult> =>
    request("GET", `/api/projects/${projectId}/bootstrap`),
  scanBootstrap: (projectId: number): Promise<ScanAndAutoSubscribeResult> =>
    request("POST", `/api/projects/${projectId}/bootstrap/scan`, {}),
  resolveBootstrap: (
    projectId: number,
    resolutions: BootstrapResolution[]
  ): Promise<ApplyResolutionsResult> =>
    request("POST", `/api/projects/${projectId}/bootstrap/resolve`, {
      resolutions
    }),
  ignoreBootstrap: (
    projectId: number,
    entries: Array<{ type: SkillType; name: string }>
  ): Promise<ApplyResolutionsResult> =>
    request("POST", `/api/projects/${projectId}/bootstrap/ignore`, { entries })
};

export { AstackError, ErrorCode };
