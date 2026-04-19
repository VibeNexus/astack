/**
 * Output helpers — shared copy style across all commands.
 *
 * Principles (design.md § Design Review decision 4 Copy Style):
 *   - Utility language, past-tense or noun forms.
 *   - State symbols: ✓ (synced), ⚠ (warn), ✗ (error), ↓ (behind), ↑ (local-ahead)
 *   - Colors via kleur; nothing fancy.
 *
 * All writes go through stdout; errors to stderr. Never throw from here.
 */

import kleur from "kleur";

export const sym = {
  ok: "✓",
  warn: "⚠",
  error: "✗",
  behind: "↓",
  ahead: "↑",
  arrow: "→",
  dot: "•"
} as const;

export function printOk(msg: string): void {
  process.stdout.write(`${kleur.green(sym.ok)} ${msg}\n`);
}

export function printInfo(msg: string): void {
  process.stdout.write(`${kleur.cyan(sym.dot)} ${msg}\n`);
}

export function printWarn(msg: string): void {
  process.stdout.write(`${kleur.yellow(sym.warn)} ${msg}\n`);
}

export function printErr(msg: string): void {
  process.stderr.write(`${kleur.red(sym.error)} ${msg}\n`);
}

export function printNext(msg: string): void {
  process.stdout.write(`  ${kleur.gray(sym.arrow)} ${kleur.gray(msg)}\n`);
}

/** Print a raw line with no decoration. */
export function print(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

/**
 * Render a small left-aligned table. Column widths are auto-computed
 * from content. Good for `astack status` and similar.
 */
export function printTable(rows: string[][]): void {
  if (rows.length === 0) return;
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      const len = stripAnsi(cell).length;
      widths[i] = Math.max(widths[i] ?? 0, len);
    });
  }
  for (const row of rows) {
    const parts = row.map((cell, i) => {
      const pad = (widths[i] ?? 0) - stripAnsi(cell).length;
      return cell + " ".repeat(Math.max(pad, 0));
    });
    process.stdout.write(parts.join("  ") + "\n");
  }
}

// ANSI escape sequences use the ESC character, not a literal backslash.
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, "");
}
