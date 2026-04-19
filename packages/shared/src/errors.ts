/**
 * Error codes and error classes for Astack.
 *
 * All inter-process errors (server → CLI/Web) use these codes so consumers
 * can react without parsing messages.
 *
 * See design.md § Code Quality Review decision 8 for the contract.
 *
 * Naming convention:
 *   - `*_NOT_FOUND`   — requested entity does not exist
 *   - `*_ALREADY_*`   — unique-constraint violation
 *   - `*_BUSY`        — resource is temporarily locked (retry possible)
 *   - `*_INVALID`     — malformed input
 *   - `*_FAILED`      — external operation failed (git, fs, network)
 */

export const ErrorCode = {
  // ---- generic ----
  /** Catch-all; prefer a specific code whenever possible. */
  INTERNAL: "INTERNAL",
  /** Zod validation failed on request input. */
  VALIDATION_FAILED: "VALIDATION_FAILED",
  /** Feature path reached but not yet implemented. */
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",

  // ---- daemon / transport ----
  /** CLI could not reach the backend daemon on 127.0.0.1:7432. */
  SERVER_UNREACHABLE: "SERVER_UNREACHABLE",
  /** Another daemon is already running (pidfile + port check). */
  SERVER_ALREADY_RUNNING: "SERVER_ALREADY_RUNNING",

  // ---- repos ----
  REPO_NOT_FOUND: "REPO_NOT_FOUND",
  /** Same git_url already registered. */
  REPO_ALREADY_REGISTERED: "REPO_ALREADY_REGISTERED",
  /** git clone/pull/push failed (details in AstackError.details.git_stderr). */
  REPO_GIT_FAILED: "REPO_GIT_FAILED",
  /**
   * Another operation holds the repo-level mutex.
   * See design.md § Eng Review decision 5.
   */
  REPO_BUSY: "REPO_BUSY",
  /** Repo contents do not match the expected structure (commands/, skills/). */
  REPO_STRUCTURE_INVALID: "REPO_STRUCTURE_INVALID",

  // ---- skills ----
  SKILL_NOT_FOUND: "SKILL_NOT_FOUND",
  /**
   * CLI got a short-name like `code_review` but multiple repos define it.
   * See design.md § Eng Review decision 6.
   */
  SKILL_REF_AMBIGUOUS: "SKILL_REF_AMBIGUOUS",
  /**
   * Single repo defines both a command and a skill with the same name and
   * user did not pass --type to disambiguate.
   */
  SKILL_TYPE_AMBIGUOUS: "SKILL_TYPE_AMBIGUOUS",

  // ---- projects ----
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  /** Same filesystem path already registered. */
  PROJECT_ALREADY_REGISTERED: "PROJECT_ALREADY_REGISTERED",
  /** Project path on disk is missing or unreadable. */
  PROJECT_PATH_MISSING: "PROJECT_PATH_MISSING",

  // ---- subscriptions ----
  SUBSCRIPTION_NOT_FOUND: "SUBSCRIPTION_NOT_FOUND",
  /**
   * Project already has a skill with the same local filename but from a
   * different repo. Only one `commands/<name>.md` allowed per project.
   */
  SUBSCRIPTION_NAME_COLLISION: "SUBSCRIPTION_NAME_COLLISION",

  // ---- sync / push / resolve ----
  /** Working copy and upstream diverged; resolve required before push. */
  CONFLICT_DETECTED: "CONFLICT_DETECTED",
  /** Resolve called for a (project, skill) that has no active conflict. */
  NO_ACTIVE_CONFLICT: "NO_ACTIVE_CONFLICT",
  /** Manual merge completed but file still contains `<<<<<<<` markers. */
  MERGE_INCOMPLETE: "MERGE_INCOMPLETE",

  // ---- tool links / symlinks ----
  TOOL_LINK_NOT_FOUND: "TOOL_LINK_NOT_FOUND",
  TOOL_LINK_ALREADY_EXISTS: "TOOL_LINK_ALREADY_EXISTS",
  /**
   * OS refused the symlink call (Windows non-dev-mode, or cross-device).
   * See design.md § Eng Review decision 3.
   */
  SYMLINK_UNSUPPORTED: "SYMLINK_UNSUPPORTED",
  /** Target dir already exists as a real directory/file; refuse to clobber. */
  SYMLINK_TARGET_OCCUPIED: "SYMLINK_TARGET_OCCUPIED",

  // ---- filesystem ----
  /** ENOSPC or similar fatal filesystem failure. */
  FILESYSTEM_FAILED: "FILESYSTEM_FAILED"
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Base error class for all Astack-thrown errors.
 *
 * Serialized over the wire as `{ code, message, details }`.
 */
export class AstackError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AstackError";
    // Preserve prototype for `instanceof` across transpilation.
    Object.setPrototypeOf(this, AstackError.prototype);
  }

  /** Wire format for HTTP responses / CLI transport. */
  toJSON(): AstackErrorBody {
    return {
      code: this.code,
      message: this.message,
      details: this.details
    };
  }

  /** Rehydrate from wire format (e.g. inside CLI after HTTP call). */
  static fromJSON(body: AstackErrorBody): AstackError {
    return new AstackError(body.code, body.message, body.details);
  }
}

/** Wire shape of an error response. */
export interface AstackErrorBody {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * HTTP status code mapping for error codes.
 * Used by server to set response status; CLI/Web does not rely on this.
 */
export const ErrorHttpStatus: Record<ErrorCode, number> = {
  INTERNAL: 500,
  VALIDATION_FAILED: 400,
  NOT_IMPLEMENTED: 501,

  SERVER_UNREACHABLE: 503,
  SERVER_ALREADY_RUNNING: 409,

  REPO_NOT_FOUND: 404,
  REPO_ALREADY_REGISTERED: 409,
  REPO_GIT_FAILED: 502,
  REPO_BUSY: 423,
  REPO_STRUCTURE_INVALID: 422,

  SKILL_NOT_FOUND: 404,
  SKILL_REF_AMBIGUOUS: 409,
  SKILL_TYPE_AMBIGUOUS: 409,

  PROJECT_NOT_FOUND: 404,
  PROJECT_ALREADY_REGISTERED: 409,
  PROJECT_PATH_MISSING: 410,

  SUBSCRIPTION_NOT_FOUND: 404,
  SUBSCRIPTION_NAME_COLLISION: 409,

  CONFLICT_DETECTED: 409,
  NO_ACTIVE_CONFLICT: 409,
  MERGE_INCOMPLETE: 422,

  TOOL_LINK_NOT_FOUND: 404,
  TOOL_LINK_ALREADY_EXISTS: 409,
  SYMLINK_UNSUPPORTED: 501,
  SYMLINK_TARGET_OCCUPIED: 409,

  FILESYSTEM_FAILED: 500
};
