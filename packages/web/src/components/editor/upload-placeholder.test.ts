import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  buildPlaceholderText,
  buildSuccessText,
  buildFailureText,
  findPlaceholderRange,
  generatePastedFilename,
  newUploadId,
  insertPlaceholder,
  replacePlaceholder,
  makeProgressUpdater,
  padToOwnLine,
} from './upload-placeholder';

/**
 * RFC-0004 Phase 6 — unit tests for the progress-placeholder lifecycle:
 * the placeholder grammar, upload-id keyed location / replacement
 * (RFC §"Multiple uploads in flight"), and the throttled progress
 * updater (5% / 500 ms).
 */

describe('placeholder text helpers', () => {
  it('builds an image placeholder with a clamped percentage', () => {
    expect(buildPlaceholderText('abc', 'pasted-1.png', 0, true)).toBe('![Uploading pasted-1.png (0%)…](#u=abc)');
    expect(buildPlaceholderText('abc', 'pasted-1.png', 37.4, true)).toBe('![Uploading pasted-1.png (37%)…](#u=abc)');
    expect(buildPlaceholderText('abc', 'pasted-1.png', 250, true)).toBe('![Uploading pasted-1.png (100%)…](#u=abc)');
  });

  it('builds a non-image placeholder without the ! image prefix', () => {
    expect(buildPlaceholderText('abc', 'notes.pdf', 0, false)).toBe('[Uploading notes.pdf (0%)…](#u=abc)');
  });

  it('builds the success token as ![name](url) / [name](url)', () => {
    expect(buildSuccessText('pasted-1.png', 'https://x/a', true)).toBe('![pasted-1.png](https://x/a)');
    expect(buildSuccessText('notes.pdf', 'https://x/b', false)).toBe('[notes.pdf](https://x/b)');
  });

  it('builds a static failure marker', () => {
    expect(buildFailureText('pasted-1.png', true)).toBe('![Upload failed: pasted-1.png](#u=done)');
    expect(buildFailureText('notes.pdf', false)).toBe('[Upload failed: notes.pdf](#u=done)');
  });
});

describe('generatePastedFilename', () => {
  it('derives the extension from the MIME type', () => {
    expect(generatePastedFilename('image/png')).toMatch(/^pasted-\d+\.png$/);
    expect(generatePastedFilename('image/jpeg')).toMatch(/^pasted-\d+\.jpg$/);
    expect(generatePastedFilename('image/webp')).toMatch(/^pasted-\d+\.webp$/);
  });

  it('falls back to png for unknown MIME types', () => {
    expect(generatePastedFilename('image/unknown')).toMatch(/^pasted-\d+\.png$/);
  });
});

describe('newUploadId', () => {
  it('returns distinct ids on successive calls', () => {
    const ids = new Set([newUploadId(), newUploadId(), newUploadId()]);
    expect(ids.size).toBe(3);
  });
});

describe('findPlaceholderRange', () => {
  it('locates the placeholder token by upload id', () => {
    const doc = 'before ![Uploading a.png (10%)…](#u=xyz) after';
    const range = findPlaceholderRange(doc, 'xyz');
    expect(range).not.toBeNull();
    expect(doc.slice(range!.from, range!.to)).toBe('![Uploading a.png (10%)…](#u=xyz)');
  });

  it('locates a non-image placeholder (no ! prefix)', () => {
    const doc = 'x [Uploading f.pdf (5%)…](#u=q1) y';
    const range = findPlaceholderRange(doc, 'q1');
    expect(doc.slice(range!.from, range!.to)).toBe('[Uploading f.pdf (5%)…](#u=q1)');
  });

  it('returns null when the upload id is not present', () => {
    expect(findPlaceholderRange('no placeholder here', 'missing')).toBeNull();
  });

  it('disambiguates two concurrent placeholders with the same filename', () => {
    const doc = '![Uploading shot.png (0%)…](#u=a) ![Uploading shot.png (0%)…](#u=b)';
    const rangeA = findPlaceholderRange(doc, 'a');
    const rangeB = findPlaceholderRange(doc, 'b');
    expect(doc.slice(rangeA!.from, rangeA!.to)).toBe('![Uploading shot.png (0%)…](#u=a)');
    expect(doc.slice(rangeB!.from, rangeB!.to)).toBe('![Uploading shot.png (0%)…](#u=b)');
  });
});

describe('padToOwnLine', () => {
  it('wraps both sides when the position is mid-line', () => {
    // pos 2 of "abcd" — surrounded by non-newline text.
    expect(padToOwnLine('abcd', 2, 'IMG')).toBe('\nIMG\n');
  });

  it('breaks a bare image off the end of a heading line', () => {
    // Dropping at the end of "## Goals" (before its trailing newline).
    expect(padToOwnLine('## Goals\nnext', 8, 'IMG')).toBe('\nIMG');
  });

  it('adds no leading newline at the start of the document', () => {
    expect(padToOwnLine('abc', 0, 'IMG')).toBe('IMG\n');
  });

  it('adds no trailing newline at the end of the document', () => {
    expect(padToOwnLine('abc', 3, 'IMG')).toBe('\nIMG');
  });

  it('adds nothing when the position already sits on a blank line', () => {
    // "a\n\nb" — pos 2 is between the two newlines.
    expect(padToOwnLine('a\n\nb', 2, 'IMG')).toBe('IMG');
  });

  it('adds only a trailing newline right after an existing newline', () => {
    expect(padToOwnLine('ab\ncd', 3, 'IMG')).toBe('IMG\n');
  });
});

describe('EditorView placeholder mutations', () => {
  let view: EditorView;

  beforeEach(() => {
    view = new EditorView({ state: EditorState.create({ doc: 'hello world' }) });
  });
  afterEach(() => view.destroy());

  it('inserts a placeholder at a position', () => {
    insertPlaceholder(view, 5, ' [INSERTED]');
    expect(view.state.doc.toString()).toBe('hello [INSERTED] world');
  });

  it('replaces a placeholder located by upload id', () => {
    insertPlaceholder(view, 11, buildPlaceholderText('u1', 'a.png', 0, true));
    replacePlaceholder(view, 'u1', buildSuccessText('a.png', 'https://x/a', true));
    expect(view.state.doc.toString()).toBe('hello world![a.png](https://x/a)');
  });

  it('replaces the correct placeholder when two are in flight', () => {
    insertPlaceholder(view, 11, buildPlaceholderText('u1', 'shot.png', 0, true));
    insertPlaceholder(view, view.state.doc.length, buildPlaceholderText('u2', 'shot.png', 0, true));
    replacePlaceholder(view, 'u2', buildSuccessText('shot.png', 'https://x/2', true));
    const doc = view.state.doc.toString();
    expect(doc).toContain('![Uploading shot.png (0%)…](#u=u1)');
    expect(doc).toContain('![shot.png](https://x/2)');
    expect(doc).not.toContain('#u=u2');
  });

  it('is a no-op when the placeholder has vanished', () => {
    const before = view.state.doc.toString();
    replacePlaceholder(view, 'gone', 'anything');
    expect(view.state.doc.toString()).toBe(before);
  });
});

describe('makeProgressUpdater throttle', () => {
  let view: EditorView;

  beforeEach(() => {
    view = new EditorView({ state: EditorState.create({ doc: '' }) });
  });
  afterEach(() => view.destroy());

  it('throttles updates below the 5% step', () => {
    insertPlaceholder(view, 0, buildPlaceholderText('u1', 'a.png', 0, true));
    const update = makeProgressUpdater(view, 'u1', 'a.png', true);

    update(2); // < 5% step, < 500 ms → throttled away
    expect(view.state.doc.toString()).toContain('(0%)');

    update(8); // ≥ 5% step → flushed
    expect(view.state.doc.toString()).toContain('(8%)');

    update(10); // only +2 from last write → throttled away
    expect(view.state.doc.toString()).toContain('(8%)');
  });

  it('always flushes a 100% completion update', () => {
    insertPlaceholder(view, 0, buildPlaceholderText('u1', 'a.png', 0, true));
    const update = makeProgressUpdater(view, 'u1', 'a.png', true);
    update(100);
    expect(view.state.doc.toString()).toContain('(100%)');
  });
});
