/**
 * HTTP client for the Astack daemon.
 *
 * Thin wrapper around `fetch`, typed per the shared API contracts.
 * Errors in the daemon's wire format (AstackErrorBody) are rehydrated
 * into AstackError instances so CLI code can `catch (e: AstackError)`.
 *
 * Deliberately no retry / no caching at this layer — each CLI command
 * decides its own failure semantics.
 */

import {
  AstackError,
  ErrorCode,
  type AstackErrorBody,
  type CreateLinkedDirRequest,
  type CreateLinkedDirResponse,
  type DeleteProjectResponse,
  type DeleteRepoResponse,
  type DeleteLinkedDirResponse,
  type GetProjectStatusResponse,
  type GetSkillDiffResponse,
  type ListProjectsResponse,
  type ListRepoSkillsResponse,
  type ListReposResponse,
  type PushRequest,
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
  type SyncRequest,
  type SyncResponse,
  type UnsubscribeResponse
} from "@astack/shared";

export interface ClientOptions {
  baseUrl: string;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

/** Response of GET /health. */
export interface HealthResponse {
  status: string;
  version: string;
  uptime_ms: number;
}

export class AstackClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // ---------- Lifecycle ----------

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health");
  }

  // ---------- Repos ----------

  async registerRepo(body: RegisterRepoRequest): Promise<RegisterRepoResponse> {
    return this.request<RegisterRepoResponse>("POST", "/api/repos", body);
  }

  async listRepos(
    q: { offset?: number; limit?: number } = {}
  ): Promise<ListReposResponse> {
    return this.request<ListReposResponse>("GET", `/api/repos${toQuery(q)}`);
  }

  async deleteRepo(id: number): Promise<DeleteRepoResponse> {
    return this.request<DeleteRepoResponse>("DELETE", `/api/repos/${id}`);
  }

  async refreshRepo(id: number): Promise<RefreshRepoResponse> {
    return this.request<RefreshRepoResponse>(
      "POST",
      `/api/repos/${id}/refresh`
    );
  }

  async listRepoSkills(id: number): Promise<ListRepoSkillsResponse> {
    return this.request<ListRepoSkillsResponse>(
      "GET",
      `/api/repos/${id}/skills`
    );
  }

  // ---------- Projects ----------

  async registerProject(
    body: RegisterProjectRequest
  ): Promise<RegisterProjectResponse> {
    return this.request<RegisterProjectResponse>(
      "POST",
      "/api/projects",
      body
    );
  }

  async listProjects(
    q: { offset?: number; limit?: number } = {}
  ): Promise<ListProjectsResponse> {
    return this.request<ListProjectsResponse>(
      "GET",
      `/api/projects${toQuery(q)}`
    );
  }

  async deleteProject(id: number): Promise<DeleteProjectResponse> {
    return this.request<DeleteProjectResponse>("DELETE", `/api/projects/${id}`);
  }

  async projectStatus(id: number): Promise<GetProjectStatusResponse> {
    return this.request<GetProjectStatusResponse>(
      "GET",
      `/api/projects/${id}/status`
    );
  }

  async skillDiff(
    projectId: number,
    skillId: number
  ): Promise<GetSkillDiffResponse> {
    return this.request<GetSkillDiffResponse>(
      "GET",
      `/api/projects/${projectId}/diff/${skillId}`
    );
  }

  // ---------- Subscriptions / sync / push / resolve ----------

  async subscribe(
    projectId: number,
    body: SubscribeRequest
  ): Promise<SubscribeResponse> {
    return this.request<SubscribeResponse>(
      "POST",
      `/api/projects/${projectId}/subscriptions`,
      body
    );
  }

  async unsubscribe(
    projectId: number,
    skillId: number
  ): Promise<UnsubscribeResponse> {
    return this.request<UnsubscribeResponse>(
      "DELETE",
      `/api/projects/${projectId}/subscriptions/${skillId}`
    );
  }

  async sync(projectId: number, body: SyncRequest = {} as SyncRequest): Promise<SyncResponse> {
    return this.request<SyncResponse>(
      "POST",
      `/api/projects/${projectId}/sync`,
      body
    );
  }

  async push(projectId: number, body: PushRequest = {}): Promise<PushResponse> {
    return this.request<PushResponse>(
      "POST",
      `/api/projects/${projectId}/push`,
      body
    );
  }

  async resolve(
    projectId: number,
    body: ResolveRequest
  ): Promise<ResolveResponse> {
    return this.request<ResolveResponse>(
      "POST",
      `/api/projects/${projectId}/resolve`,
      body
    );
  }

  // ---------- Linked dirs ----------

  async createLinkedDir(
    projectId: number,
    body: CreateLinkedDirRequest
  ): Promise<CreateLinkedDirResponse> {
    return this.request<CreateLinkedDirResponse>(
      "POST",
      `/api/projects/${projectId}/links`,
      body
    );
  }

  async deleteLinkedDir(
    projectId: number,
    toolName: string
  ): Promise<DeleteLinkedDirResponse> {
    return this.request<DeleteLinkedDirResponse>(
      "DELETE",
      `/api/projects/${projectId}/links/${encodeURIComponent(toolName)}`
    );
  }

  // ---------- Internal ----------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (err) {
      // Network-level failure → daemon likely not running.
      throw new AstackError(
        ErrorCode.SERVER_UNREACHABLE,
        `could not reach astack daemon at ${this.baseUrl}`,
        { error: err instanceof Error ? err.message : String(err) }
      );
    }

    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : undefined;

    if (!res.ok) {
      // Try to rehydrate into AstackError.
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
}

function toQuery(q: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

function isAstackErrorBody(value: unknown): value is AstackErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    typeof (value as { code: unknown }).code === "string" &&
    typeof (value as { message: unknown }).message === "string"
  );
}
