/**
 * Wrapper around @hono/zod-validator that converts validation failures
 * into our standard AstackError(VALIDATION_FAILED) wire format.
 *
 * Use everywhere you'd use `zValidator(...)` directly.
 */

import {
  AstackError,
  ErrorCode,
  type AstackErrorBody
} from "@astack/shared";
import { zValidator as zValidatorOriginal } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { ZodSchema } from "zod";

export function zValidator<
  Target extends keyof ValidationTargets,
  Schema extends ZodSchema
>(target: Target, schema: Schema) {
  return zValidatorOriginal(target, schema, (result, c) => {
    if (!result.success) {
      const err = new AstackError(
        ErrorCode.VALIDATION_FAILED,
        `request failed schema validation on ${target}`,
        { issues: result.error.issues }
      );
      const body: AstackErrorBody = err.toJSON();
      return c.json(body, 400);
    }
    // On success, zod-validator handles the result internally; we only
    // override the failure path.
    return undefined;
  });
}
