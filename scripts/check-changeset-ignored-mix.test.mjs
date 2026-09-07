import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findMixed, parsePackages } from './check-changeset-ignored-mix.mjs';

const IGNORE = ['@crowi/tsconfig', '@crowi/svg-sanitize'];

test('parsePackages reads single-quoted, double-quoted and bare names', () => {
  const source = ["---", "'@crowi/api': patch", '"@crowi/web": minor', '@crowi/collab: major', '---', '', 'body'].join('\n');
  assert.deepEqual(parsePackages(source), ['@crowi/api', '@crowi/web', '@crowi/collab']);
});

test('parsePackages stops at the frontmatter and ignores the body', () => {
  const source = ["---", "'@crowi/api': patch", '---', '', 'Prose that mentions `@crowi/web`: not a package entry.'].join('\n');
  assert.deepEqual(parsePackages(source), ['@crowi/api']);
});

test('parsePackages returns nothing when there is no frontmatter', () => {
  assert.deepEqual(parsePackages('just prose\n'), []);
});

test('flags the shape that broke the release: one ignored beside published ones', () => {
  const source = ["---", "'@crowi/plugin-renderer-mermaid': patch", "'@crowi/svg-sanitize': patch", "'@crowi/plugin-api': patch", '---', '', 'body'].join('\n');
  const problems = findMixed([{ file: '.changeset/deps.md', source }], IGNORE);
  assert.equal(problems.length, 1);
  assert.deepEqual(problems[0].ignored, ['@crowi/svg-sanitize']);
  assert.deepEqual(problems[0].published, ['@crowi/plugin-renderer-mermaid', '@crowi/plugin-api']);
});

test('accepts a changeset of published packages only', () => {
  const source = ["---", "'@crowi/api': patch", "'@crowi/web': patch", '---', '', 'body'].join('\n');
  assert.deepEqual(findMixed([{ file: '.changeset/a.md', source }], IGNORE), []);
});

test('accepts a changeset of ignored packages only — changesets allows that', () => {
  const source = ["---", "'@crowi/svg-sanitize': patch", "'@crowi/tsconfig': patch", '---', '', 'body'].join('\n');
  assert.deepEqual(findMixed([{ file: '.changeset/b.md', source }], IGNORE), []);
});

test('an empty ignore list can never produce a mix', () => {
  const source = ["---", "'@crowi/svg-sanitize': patch", "'@crowi/api': patch", '---', '', 'body'].join('\n');
  assert.deepEqual(findMixed([{ file: '.changeset/c.md', source }], []), []);
});

test('reports every offending file, not just the first', () => {
  const mix = (pkg) => ["---", `'${pkg}': patch`, "'@crowi/svg-sanitize': patch", '---', '', 'body'].join('\n');
  const problems = findMixed(
    [
      { file: '.changeset/one.md', source: mix('@crowi/api') },
      { file: '.changeset/two.md', source: mix('@crowi/web') },
    ],
    IGNORE,
  );
  assert.deepEqual(
    problems.map((p) => p.file),
    ['.changeset/one.md', '.changeset/two.md'],
  );
});
