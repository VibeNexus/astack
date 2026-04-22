/**
 * Compile-time globals injected by the build tool.
 *
 * `__APP_VERSION__` is defined in both `vite.config.ts` and
 * `vitest.config.ts` (`define` option) and resolves to the value of
 * `@astack/web`'s own `package.json#version` at build time.
 *
 * See `packages/server/src/version.ts` / `packages/cli/src/version.ts`
 * for the runtime equivalents on the Node side.
 */

// eslint-disable-next-line @typescript-eslint/naming-convention
declare const __APP_VERSION__: string;
