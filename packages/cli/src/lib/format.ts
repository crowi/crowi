/**
 * Output formatting for list-style commands (`search`, `ls`). On top of the
 * default human output and `--json`, commands accept:
 *   - `--format <json|table|template>` — pick a rendering mode.
 *   - `--template '<str>'` — a row template with `{{field}}` placeholders,
 *     evaluated once per record. Selecting a template implies template mode.
 *
 * The template language is intentionally tiny (no logic / no helpers): a
 * `{{path}}` token is replaced by the record's `path` field. Dotted paths
 * (`{{page.path}}`) walk nested objects. Missing fields render empty. This
 * keeps piping scriptable (`crowi search foo --template '{{path}}'`) without
 * pulling in a templating dependency.
 */
import { CliError, EXIT } from './http';

/** The explicit `--format` modes. `human` is the implicit default. */
export const FORMAT_MODES = ['json', 'table', 'template', 'human'] as const;
export type FormatMode = (typeof FORMAT_MODES)[number];

export interface FormatOptions {
  /** `--format <mode>`. */
  format?: string;
  /** `--template <string>`; implies `--format template`. */
  template?: string;
  /** `--json` global flag — equivalent to `--format json`. */
  json?: boolean;
}

/**
 * Resolve the effective format mode from the (possibly conflicting) flags.
 * Precedence: an explicit `--template` wins (template mode); then an explicit
 * `--format`; then the `--json` global; otherwise `human`. Throws on an
 * unknown `--format` value or `--format json` combined with `--template`.
 */
export function resolveFormat(opts: FormatOptions): FormatMode {
  if (opts.format !== undefined && !FORMAT_MODES.includes(opts.format as FormatMode)) {
    throw new CliError(`unknown --format "${opts.format}" — choose one of: ${FORMAT_MODES.join(', ')}`, {
      exitCode: EXIT.INVALID,
    });
  }
  if (opts.template !== undefined) {
    if (opts.format !== undefined && opts.format !== 'template') {
      throw new CliError(`--template cannot be combined with --format ${opts.format}`, { exitCode: EXIT.INVALID });
    }
    return 'template';
  }
  if (opts.format !== undefined) {
    return opts.format as FormatMode;
  }
  if (opts.json) {
    return 'json';
  }
  return 'human';
}

/** Read a (possibly dotted) field path from a record; undefined when absent. */
function readField(record: unknown, path: string): unknown {
  let cursor: unknown = record;
  for (const key of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * Stringify a field VALUE for template/table cells (objects → JSON), then
 * collapse any embedded `\r\n` / `\n` / `\t` to a single space so a record
 * whose field contains a newline/tab can't break table column alignment or
 * the one-line-per-record contract of `--template`/TSV output. This flattens
 * the substituted VALUE only — `applyTemplate` still honours the user's
 * intentional `\t`/`\n` separators in the TEMPLATE literal (applied before
 * substitution).
 */
function cell(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return str.replace(/[\r\n\t]+/g, ' ').trim();
}

/**
 * Apply a `{{field}}` template to one record. Unknown / missing fields render
 * as the empty string. Literal text outside `{{…}}` is preserved verbatim, so
 * `--template '{{path}}\t{{score}}'` yields a tab-separated line.
 */
export function applyTemplate(template: string, record: unknown): string {
  // Support common backslash escapes in the template literal so a shell-quoted
  // '\t' / '\n' produces an actual tab / newline.
  const unescaped = template.replace(/\\t/g, '\t').replace(/\\n/g, '\n');
  return unescaped.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, field: string) => cell(readField(record, field)));
}

/**
 * Render a list of records as a simple aligned table given an ordered set of
 * columns. The header row uses the column key; cells read the (dotted) field.
 */
export function renderTable(records: readonly unknown[], columns: readonly string[]): string {
  const header = columns;
  const rows = records.map((rec) => columns.map((col) => cell(readField(rec, col))));
  const widths = columns.map((_col, i) => Math.max(header[i].length, ...rows.map((r) => r[i].length), 0));
  const fmtRow = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [fmtRow([...header]), ...rows.map(fmtRow)].join('\n');
}

/**
 * Render a record list in the resolved mode. `json` dumps the raw `value`
 * (the full response, so metadata is preserved); `template` renders one line
 * per record; `table` renders aligned columns; `human`/default falls back to
 * the caller-provided `humanLine` per record.
 */
export function renderRecords(
  value: unknown,
  records: readonly unknown[],
  mode: FormatMode,
  opts: {
    template?: string;
    columns: readonly string[];
    humanLine: (record: unknown) => string;
    emptyHuman: string;
  },
): void {
  if (mode === 'json') {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (records.length === 0) {
    if (mode === 'human') {
      process.stdout.write(`${opts.emptyHuman}\n`);
    }
    // table/template over an empty set print nothing (pipe-friendly).
    return;
  }
  let lines: string[];
  if (mode === 'template') {
    const tpl = opts.template ?? opts.columns.map((c) => `{{${c}}}`).join('\t');
    lines = records.map((rec) => applyTemplate(tpl, rec));
  } else if (mode === 'table') {
    process.stdout.write(`${renderTable(records, opts.columns)}\n`);
    return;
  } else {
    lines = records.map((rec) => opts.humanLine(rec));
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}
