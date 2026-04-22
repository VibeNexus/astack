/**
 * v0.6 — Format the "N failed" toast detail line for batch-resolve failures.
 *
 * Pre-v0.6 the toast only showed an aggregate count ("Resolved 0, 38 failed"),
 * which left users with no hint about root-cause. v0.6 threads per-skill
 * `error_detail` (typically git_stderr fragments) from `BatchResolveResponse`
 * outcomes into the toast's secondary text.
 *
 * Rules:
 *   - Use the first 3 failing outcomes; anything beyond is summarized as
 *     "(N more)" so a 38-skill batch doesn't produce a toast the size of
 *     a novel.
 *   - Prefer `error_detail` (git_stderr fragment) over `error` (which is
 *     usually just "git pull failed").
 *   - Truncate each sample to 200 chars (ellipsis) to keep the toast sane.
 *   - If no sample carries any text, fall back to a generic hint.
 */

export interface BatchResolveFailureOutcome {
  success: boolean;
  error?: string;
  error_detail?: string;
}

const SAMPLE_LIMIT = 3;
const TRUNCATE_LIMIT = 200;

function truncate(s: string): string {
  return s.length > TRUNCATE_LIMIT ? s.slice(0, TRUNCATE_LIMIT) + "…" : s;
}

/**
 * Build a single string suitable for the `detail` argument of `toast.warn`.
 *
 * `outcomes` is the full list from `BatchResolveResponse.outcomes`.
 */
export function formatBatchResolveFailureDetail(
  outcomes: BatchResolveFailureOutcome[]
): string {
  const failures = outcomes.filter(
    (o) => !o.success && ((o.error_detail && o.error_detail.length > 0) || (o.error && o.error.length > 0))
  );
  if (failures.length === 0) {
    return "Some skills could not be resolved — check individually.";
  }

  const samples = failures
    .slice(0, SAMPLE_LIMIT)
    .map((o) => truncate(o.error_detail ?? o.error ?? ""))
    .filter((s) => s.length > 0);

  const more = failures.length - samples.length;

  if (samples.length === 0) {
    return "Some skills could not be resolved — check individually.";
  }

  const head = `First error: ${samples[0]}`;
  const rest = samples.length > 1 ? `; also: ${samples.slice(1).join("; ")}` : "";
  const tail = more > 0 ? ` (${more} more)` : "";
  return head + rest + tail;
}
