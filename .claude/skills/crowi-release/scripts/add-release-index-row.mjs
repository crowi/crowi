#!/usr/bin/env node
// Inserts one release row into the team wiki's /crowi/release/ index body.
//
//   node add-release-index-row.mjs --in <index.md> --out <new.md> \
//     --version v2.0.0-alpha.N --page /crowi/release/YYYY/MM/DD/alpha-N \
//     --date YYYY-MM-DD --summary "<変更点>"
//
// Exits 1 without writing when the summary exceeds MAX_SUMMARY_CHARS, when the
// version already has a row, or when the index has no release table. The cap
// is enforced here rather than left to the writer because a written limit was
// broken release after release: the summary kept absorbing procedures and
// notes from the detail page.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

export const MAX_SUMMARY_CHARS = 200;

const ROW_PREFIX = '| [v';

export function insertReleaseRow(index, { version, page, date, summary }) {
  const text = summary.trim();
  if (text.includes('\n') || text.includes('|')) {
    throw new Error('summary must be a single table cell: no newline and no "|"');
  }
  const length = [...text].length;
  if (length > MAX_SUMMARY_CHARS) {
    throw new Error(`summary is ${length} characters; the limit is ${MAX_SUMMARY_CHARS}. Move procedures, reasons and asides to the detail page.`);
  }
  const lines = index.split('\n');
  if (lines.some((line) => line.startsWith(`| [${version}](`))) {
    throw new Error(`the index already has a row for ${version}`);
  }
  const first = lines.findIndex((line) => line.startsWith(ROW_PREFIX));
  if (first === -1) {
    throw new Error('no release row found to insert above');
  }
  lines.splice(first, 0, `| [${version}](${page}) | ${date} | ${text} |`);
  return lines.join('\n');
}

function main() {
  const { values } = parseArgs({
    options: {
      in: { type: 'string' },
      out: { type: 'string' },
      version: { type: 'string' },
      page: { type: 'string' },
      date: { type: 'string' },
      summary: { type: 'string' },
    },
  });
  const missing = ['in', 'out', 'version', 'page', 'date', 'summary'].filter((k) => !values[k]);
  if (missing.length > 0) {
    console.error(`missing options: ${missing.map((k) => `--${k}`).join(' ')}`);
    process.exit(1);
  }
  try {
    const next = insertReleaseRow(readFileSync(values.in, 'utf8'), values);
    writeFileSync(values.out, next);
    console.log(`inserted ${values.version} (${[...values.summary.trim()].length}/${MAX_SUMMARY_CHARS} characters)`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
