/**
 * Single source of truth for the CLI package version.
 *
 * Read from `@astack/cli`'s own `package.json` at runtime so
 * `astack --version` always matches the published npm version without a
 * hand-maintained string literal.
 *
 * See `packages/server/src/version.ts` for the same pattern on the server
 * side, and the rationale for `createRequire` vs. JSON imports.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface PkgJson {
  version: string;
}

const pkg = require("../package.json") as PkgJson;

export const VERSION: string = pkg.version;
