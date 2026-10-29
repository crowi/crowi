import assert from 'node:assert/strict';
import { test } from 'node:test';

import { insertReleaseRow, MAX_SUMMARY_CHARS } from '../scripts/add-release-index-row.mjs';

const INDEX = ['# Releases', '', '| 版 | 日付 | 変更点 |', '|---|---|---|', '| [v2.0.0-alpha.25](/crowi/release/2026/10/22/alpha-25) | 2026-10-22 | 運用側の作業なし |', ''].join('\n');

const ROW = { version: 'v2.0.0-alpha.26', page: '/crowi/release/2026/10/24/alpha-26', date: '2026-10-24' };

test('inserts the new row above the newest existing row and changes nothing else', () => {
  const out = insertReleaseRow(INDEX, { ...ROW, summary: '依存更新: Next.js 16.4.3 ほか' });
  const before = INDEX.split('\n');
  const after = out.split('\n');
  assert.equal(after.length, before.length + 1);
  assert.equal(after[4], '| [v2.0.0-alpha.26](/crowi/release/2026/10/24/alpha-26) | 2026-10-24 | 依存更新: Next.js 16.4.3 ほか |');
  assert.deepEqual([...after.slice(0, 4), ...after.slice(5)], before);
});

test('accepts a summary of exactly the limit, counting Japanese characters as one each', () => {
  const summary = 'あ'.repeat(MAX_SUMMARY_CHARS);
  assert.ok(insertReleaseRow(INDEX, { ...ROW, summary }).includes(summary));
});

test('rejects a summary over the limit', () => {
  assert.throws(() => insertReleaseRow(INDEX, { ...ROW, summary: 'あ'.repeat(MAX_SUMMARY_CHARS + 1) }), /201 characters/);
});

test('rejects a second row for the same version', () => {
  const once = insertReleaseRow(INDEX, { ...ROW, summary: 'x' });
  assert.throws(() => insertReleaseRow(once, { ...ROW, summary: 'y' }), /already has a row/);
});

test('rejects a summary that would break the table cell', () => {
  assert.throws(() => insertReleaseRow(INDEX, { ...ROW, summary: 'a | b' }), /single table cell/);
  assert.throws(() => insertReleaseRow(INDEX, { ...ROW, summary: 'a\nb' }), /single table cell/);
});

test('rejects an index without a release row', () => {
  assert.throws(() => insertReleaseRow('# Releases\n', { ...ROW, summary: 'x' }), /no release row/);
});
