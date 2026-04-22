/**
 * Single source of truth for the server package version.
 *
 * Reads `@astack/server`'s own `package.json` at runtime so there is no
 * string literal drift between `/health`, the SSE `hello` payload, the
 * exported `VERSION` constant, and the published npm version.
 *
 * Implementation notes:
 *   - We use `createRequire(import.meta.url)` rather than a `with { type:
 *     "json" }` import so this stays compatible with the current
 *     `module: NodeNext` setup without pulling `package.json` into
 *     `rootDir`/`dist`.
 *   - The require is resolved relative to THIS file, so it still points at
 *     the right `package.json` after `tsc` emits `dist/version.js` (which
 *     sits one level deeper than the package root → `../package.json`).
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface PkgJson {
  version: string;
}

const pkg = require("../package.json") as PkgJson;

export const VERSION: string = pkg.version;
