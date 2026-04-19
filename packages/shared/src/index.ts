/**
 * @astack/shared — Types, schemas, and error codes shared across server, cli, and web.
 *
 * Single source of truth for API contracts.
 * See docs/asset/design.md § Engineering Review decision 8 for the spec.
 *
 * Import surface:
 *   - domain types:  import { Project, Skill, ... } from "@astack/shared"
 *   - zod schemas:   import { RegisterRepoRequestSchema, ... } from "@astack/shared"
 *   - errors:        import { AstackError, ErrorCode, ... } from "@astack/shared"
 *
 * Subpath imports also work:
 *   - "@astack/shared/errors"
 *   - "@astack/shared/schemas"
 */

export * from "./domain.js";
export * from "./errors.js";
export * from "./schemas/index.js";
