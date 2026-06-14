/**
 * Output rendering for the CLI. Two modes:
 *   - `--json`: print the raw value as pretty JSON to stdout (machine mode).
 *   - human (default): print a caller-provided human string.
 * `--quiet` suppresses non-essential human output (progress / confirmations)
 * but never suppresses `--json` payloads or errors.
 */
export interface OutputOptions {
  json?: boolean;
  quiet?: boolean;
}

/**
 * Render a result. In `--json` mode the structured `value` is emitted as
 * pretty JSON; otherwise the `human` string (or a lazy producer of it) is
 * printed. When `human` is omitted in human mode the value is JSON-dumped as
 * a fallback so no command is ever silent without `--json`.
 */
export function render(value: unknown, human: string | (() => string) | undefined, opts: OutputOptions): void {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const text = typeof human === 'function' ? human() : human;
  if (text !== undefined) {
    process.stdout.write(`${text}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Print an informational/progress line to stderr (so it never pollutes
 * `--json` stdout) unless `--quiet` is set. Use for "Opening browser…",
 * "Done", and similar chatter.
 */
export function info(message: string, opts: OutputOptions): void {
  if (opts.quiet) return;
  process.stderr.write(`${message}\n`);
}

/**
 * Print a warning to stderr. Warnings (e.g. version-skew notices) are shown
 * even under `--quiet` since they signal something the user should know, but
 * they are still kept off stdout so machine consumers are unaffected.
 */
export function warn(message: string): void {
  process.stderr.write(`crowi: warning: ${message}\n`);
}

/**
 * Render a simple aligned two-column table to a string (no external deps).
 * Empty input yields an empty string.
 */
export function table(rows: Array<[string, string]>): string {
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map(([key]) => key.length));
  return rows.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join('\n');
}
