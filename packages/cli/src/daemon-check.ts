/**
 * Daemon availability check.
 *
 * Every command first probes /health. On failure we print a clear
 * instruction to run `astack server start` and exit non-zero (decision #4).
 * This also helps avoid cryptic connection-refused errors for new users.
 */

import { AstackError, ErrorCode } from "@astack/shared";

import type { AstackClient } from "./client.js";

export interface DaemonInfo {
  status: string;
  version: string;
  uptime_ms: number;
}

/**
 * Verify the daemon is reachable. Throws AstackError(SERVER_UNREACHABLE)
 * with a helpful message; callers should let this propagate and be caught
 * by the bin.ts top-level handler.
 */
export async function ensureDaemonOnline(client: AstackClient): Promise<DaemonInfo> {
  try {
    return await client.health();
  } catch (err) {
    if (err instanceof AstackError && err.code === ErrorCode.SERVER_UNREACHABLE) {
      throw new AstackError(
        ErrorCode.SERVER_UNREACHABLE,
        "astack daemon is not running. Start it with: astack server start",
        err.details
      );
    }
    throw err;
  }
}
