#!/usr/bin/env node
// Guards that no changeset lists both an ignored and a non-ignored package.
//
// Why this exists: `.changeset/config.json` `ignore` holds packages that are
// never published on their own (`private: true`, shipped bundled inside a
// consumer). `changeset version` refuses a file that asks to bump one of those
// alongside a package it does publish — "Mixed changesets that contain both
// ignored and not ignored packages are not allowed" — and it refuses at the
// FIRST step of the release job, so nothing downstream runs: no npm publish, no
// distribution tag, no GitHub release, no image. The push looks fine, CI goes
// green, and only the release workflow goes red.
//
// This bit the xmldom security batch on 2026-09-06: `@crowi/svg-sanitize` (a
// bundled sanitiser, on the ignore list) was listed next to the two published
// packages that carry it. Nothing about the changeset looked wrong while
// writing it — the mix is only visible if you already know the ignore list —
// which is exactly the kind of thing a hook should decide instead of a person.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const CHANGESET_DIR = '.changeset';
const CONFIG = join(CHANGESET_DIR, 'config.json');

/** Package names in a changeset's YAML frontmatter (`'name': bump` lines). */
export function parsePackages(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!match) return [];
  const names = [];
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^\s*(?:'([^']+)'|"([^"]+)"|([^:\s]+))\s*:/.exec(line);
    if (entry) names.push(entry[1] ?? entry[2] ?? entry[3]);
  }
  return names;
}

/** The offending changesets, as `{ file, ignored, published }`. */
export function findMixed(entries, ignore) {
  const ignored = new Set(ignore);
  const problems = [];
  for (const { file, source } of entries) {
    const packages = parsePackages(source);
    const inIgnore = packages.filter((p) => ignored.has(p));
    const notInIgnore = packages.filter((p) => !ignored.has(p));
    if (inIgnore.length && notInIgnore.length) {
      problems.push({ file, ignored: inIgnore, published: notInIgnore });
    }
  }
  return problems;
}

function main() {
  if (!existsSync(CONFIG)) return 0;

  let ignore;
  try {
    ignore = JSON.parse(readFileSync(CONFIG, 'utf8')).ignore ?? [];
  } catch (err) {
    process.stderr.write(`\n✗ ${CONFIG} is unreadable (${err.message})\n`);
    return 1;
  }
  if (!ignore.length) return 0;

  const entries = readdirSync(CHANGESET_DIR)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .map((name) => ({ file: join(CHANGESET_DIR, name), source: readFileSync(join(CHANGESET_DIR, name), 'utf8') }));

  const problems = findMixed(entries, ignore);
  if (!problems.length) {
    process.stdout.write('✓ No changeset mixes ignored and published packages.\n');
    return 0;
  }

  process.stderr.write('\n✗ A changeset lists both an ignored and a published package:\n\n');
  for (const { file, ignored, published } of problems) {
    process.stderr.write(`    ${file}\n`);
    process.stderr.write(`      ignored (never published):  ${ignored.join(', ')}\n`);
    process.stderr.write(`      published:                  ${published.join(', ')}\n`);
  }
  process.stderr.write('\n  `changeset version` rejects this and fails the release job before it\n');
  process.stderr.write('  publishes anything, so the break only shows up after the push.\n');
  process.stderr.write(`\n  Drop the ignored package(s) from the frontmatter. They carry no version of\n`);
  process.stderr.write('  their own, so removing them changes neither the bumps nor the release notes —\n');
  process.stderr.write('  keep naming them in the body if that is what makes the change legible.\n\n');
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
