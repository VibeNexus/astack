/**
 * @astack/server — Backend service (Hono + SQLite + git).
 *
 * Responsibilities:
 * - Project registration and subscription management
 * - Skill repo git operations (clone, pull, push, scan)
 * - Sync state tracking and conflict detection
 * - Tool symlink management
 * - REST API for CLI and Web
 * - SSE event stream
 *
 * See docs/asset/design.md § Engineering Review for architecture.
 */

export const VERSION = "0.1.0";
