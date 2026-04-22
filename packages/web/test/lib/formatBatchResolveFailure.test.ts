/**
 * v0.6 — Unit tests for `formatBatchResolveFailureDetail`.
 *
 * Covers the "first N with `(M more)` tail" rule used by
 * `ProjectDetailPage.onResolveAllConflicts` to build the toast detail line.
 */

import { describe, expect, it } from "vitest";

import { formatBatchResolveFailureDetail } from "../../src/lib/formatBatchResolveFailure.js";

describe("formatBatchResolveFailureDetail", () => {
  it("returns generic hint when outcomes carry no error text", () => {
    const detail = formatBatchResolveFailureDetail([
      { success: true },
      { success: false } // failure but no error/error_detail
    ]);
    expect(detail).toBe(
      "Some skills could not be resolved — check individually."
    );
  });

  it("returns generic hint when outcomes list is empty", () => {
    const detail = formatBatchResolveFailureDetail([]);
    expect(detail).toBe(
      "Some skills could not be resolved — check individually."
    );
  });

  it("prefers error_detail over error for the first sample", () => {
    const detail = formatBatchResolveFailureDetail([
      {
        success: false,
        error: "git pull failed",
        error_detail:
          "Your local changes would be overwritten by merge: qa/SKILL.md"
      }
    ]);
    expect(detail).toBe(
      "First error: Your local changes would be overwritten by merge: qa/SKILL.md"
    );
  });

  it("falls back to error when error_detail is absent", () => {
    const detail = formatBatchResolveFailureDetail([
      { success: false, error: "boom" }
    ]);
    expect(detail).toBe("First error: boom");
  });

  it("surfaces first 3 samples and a '(N more)' tail", () => {
    const detail = formatBatchResolveFailureDetail([
      { success: false, error_detail: "e1" },
      { success: false, error_detail: "e2" },
      { success: false, error_detail: "e3" },
      { success: false, error_detail: "e4" },
      { success: false, error_detail: "e5" }
    ]);
    expect(detail).toBe("First error: e1; also: e2; e3 (2 more)");
  });

  it("emits '(1 more)' when exactly 4 failures", () => {
    const detail = formatBatchResolveFailureDetail([
      { success: false, error_detail: "e1" },
      { success: false, error_detail: "e2" },
      { success: false, error_detail: "e3" },
      { success: false, error_detail: "e4" }
    ]);
    expect(detail).toBe("First error: e1; also: e2; e3 (1 more)");
  });

  it("omits 'also' and '(N more)' when exactly 1 failure", () => {
    const detail = formatBatchResolveFailureDetail([
      { success: true },
      { success: true },
      { success: false, error_detail: "only one" }
    ]);
    expect(detail).toBe("First error: only one");
  });

  it("truncates each sample to 200 chars with an ellipsis", () => {
    const long = "x".repeat(500);
    const detail = formatBatchResolveFailureDetail([
      { success: false, error_detail: long }
    ]);
    expect(detail.startsWith("First error: " + "x".repeat(200))).toBe(true);
    expect(detail.endsWith("…")).toBe(true);
    // "First error: " + 200 x + "…" = 13 + 200 + 1 = 214
    expect(detail.length).toBe(214);
  });

  it("filters out successes when counting failures for '(N more)'", () => {
    const detail = formatBatchResolveFailureDetail([
      { success: true },
      { success: false, error_detail: "e1" },
      { success: true },
      { success: false, error_detail: "e2" },
      { success: false, error_detail: "e3" },
      { success: false, error_detail: "e4" }
    ]);
    expect(detail).toBe("First error: e1; also: e2; e3 (1 more)");
  });
});
