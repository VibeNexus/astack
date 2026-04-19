/**
 * HTTP error middleware.
 *
 * Catches anything thrown from routes and converts to the wire format
 * defined by AstackErrorBody in @astack/shared.
 *
 * Contract:
 *   - AstackError          → status from ErrorHttpStatus + serialized body
 *   - ZodError             → 400 VALIDATION_FAILED with issues in details
 *   - any other Error      → 500 INTERNAL (message only; no stack trace)
 */

import {
  AstackError,
  ErrorCode,
  ErrorHttpStatus,
  type AstackErrorBody
} from "@astack/shared";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";

import type { Logger } from "../logger.js";

export function buildErrorHandler(logger: Logger) {
  return (err: Error, c: Context): Response => {
    if (err instanceof AstackError) {
      const status = ErrorHttpStatus[err.code] as ContentfulStatusCode;
      const body: AstackErrorBody = err.toJSON();
      return c.json(body, status);
    }

    if (err instanceof ZodError) {
      logger.debug("http.zod_validation_failed", {
        issues: err.issues.length
      });
      const body: AstackErrorBody = {
        code: ErrorCode.VALIDATION_FAILED,
        message: "request failed schema validation",
        details: { issues: err.issues }
      };
      return c.json(body, 400);
    }

    logger.error("http.unhandled", {
      error: err.message,
      name: err.name
    });
    const body: AstackErrorBody = {
      code: ErrorCode.INTERNAL,
      message: err.message ?? "internal error"
    };
    return c.json(body, 500);
  };
}
