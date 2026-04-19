/**
 * Error codes and error classes for Astack.
 *
 * All inter-process errors (server → CLI/Web) use these codes so consumers
 * can react without parsing messages.
 *
 * See docs/asset/design.md § Code Quality Review § 8 for details.
 */

export const ErrorCode = {
  // To be filled in — see design doc 18 endpoints
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED"
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AstackError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AstackError";
  }
}
