/**
 * `/api/fs/*` schemas — filesystem navigation helper for the dashboard.
 *
 * These endpoints exist solely to power the "path autocomplete" UI in the
 * Register Project dialog. Without them the user would have to type an
 * absolute path from memory because the browser sandbox hides real paths
 * from `<input type="file">`.
 *
 * Safety model (127.0.0.1-only daemon + single local user):
 *   - Listing is read-only.
 *   - We accept absolute paths only (no "." / "./foo" / "~/foo").
 *   - The daemon never returns file contents, only directory entries.
 *
 * If astack ever grows multi-user auth or exposes the daemon beyond
 * loopback, revisit: a read-only fs browser over HTTP is a liability.
 */

import { z } from "zod";

/**
 * Query params for `GET /api/fs/list`.
 *
 * `path` is the directory whose children to list. It must be an absolute
 * path. Omit (or pass empty) to get `$HOME`.
 */
export const FsListQuerySchema = z.object({
  path: z.string().optional(),
  /** If "1", include dot-files/dirs. Default hides them. */
  show_hidden: z
    .union([z.literal("0"), z.literal("1"), z.literal("true"), z.literal("false")])
    .optional()
});
export type FsListQuery = z.infer<typeof FsListQuerySchema>;

export const FsEntryKind = {
  Dir: "dir",
  File: "file"
} as const;
export type FsEntryKind = (typeof FsEntryKind)[keyof typeof FsEntryKind];

/**
 * A single child entry under the listed directory.
 *
 * `path` is the joined absolute path — the UI uses it directly as the
 * next `path` query param when the user navigates into a dir.
 */
export const FsEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum([FsEntryKind.Dir, FsEntryKind.File]),
  /** Leading-dot entry (e.g. ".git"). The UI may de-emphasize these. */
  hidden: z.boolean()
});
export type FsEntry = z.infer<typeof FsEntrySchema>;

export const FsListResponseSchema = z.object({
  /**
   * The absolute path that was actually listed, post-normalization.
   * Useful for the UI to sync its input field with what the server saw.
   */
  path: z.string(),
  /** Absolute path of the parent directory, or null if this is root ("/"). */
  parent: z.string().nullable(),
  /** Whether this path exists and is a directory. */
  exists: z.boolean(),
  entries: z.array(FsEntrySchema)
});
export type FsListResponse = z.infer<typeof FsListResponseSchema>;
