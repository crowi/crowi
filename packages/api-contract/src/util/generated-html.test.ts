import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isGeneratedHtmlOrigin, markGeneratedHtml } from './generated-html';

describe('generated HTML origin', () => {
  it('origin-shape: accepts only the number 1', () => {
    assert.equal(isGeneratedHtmlOrigin(1), true);
    for (const bad of ['1', true, {}, 0, 2, -1, 1.5, null, undefined, [1], { g: 1 }]) {
      assert.equal(isGeneratedHtmlOrigin(bad), false);
    }
  });

  it('markGeneratedHtml sets data.g on the same node and merges existing data', () => {
    const bare = { type: 'html', value: 'x' } as { type: string; value: string; data?: Record<string, unknown> };
    assert.equal(markGeneratedHtml(bare), bare);
    assert.deepEqual(bare.data, { g: 1 });

    const withSidecar = { type: 'html', value: 'x', data: { crowiCode: { lang: 'ts' } } } as { type: string; value: string; data?: Record<string, unknown> };
    markGeneratedHtml(withSidecar);
    assert.deepEqual(withSidecar.data, { crowiCode: { lang: 'ts' }, g: 1 });
  });

  it('JSON growth is 15 / 5 / 6 bytes for no data / empty data / non-empty data, and the data object is 7 bytes', () => {
    const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');
    const none: { type: string; value: string; data?: Record<string, unknown> } = { type: 'html', value: 'x' };
    assert.equal(size(markGeneratedHtml({ ...none })) - size(none), 15);
    const empty = { ...none, data: {} };
    assert.equal(size(markGeneratedHtml({ ...empty, data: {} })) - size(empty), 5);
    const filled = { ...none, data: { a: 1 } };
    assert.equal(size(markGeneratedHtml({ ...filled, data: { a: 1 } })) - size(filled), 6);
    assert.equal(size({ g: 1 }), 7);
  });

  it('an HTML attribute or class that spells the mark is not an origin', () => {
    assert.equal(isGeneratedHtmlOrigin('<span data-g="1" class="g">'), false);
  });
});
