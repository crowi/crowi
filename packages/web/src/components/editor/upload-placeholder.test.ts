import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPlaceholderText,
  buildSuccessText,
  findPlaceholderRange,
  generatePastedFilename,
  insertPlaceholder,
  makeProgressUpdater,
  newUploadId,
  ownLinePadding,
  removePlaceholder,
  replacePlaceholder,
  uploadAttachment,
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

describe('ownLinePadding', () => {
  it('pads both sides when the position is mid-line', () => {
    // pos 2 of "abcd" — surrounded by non-newline text.
    expect(ownLinePadding('abcd', 2)).toEqual({ leading: '\n', trailing: '\n' });
  });

  it('breaks a bare image off the end of a heading line', () => {
    // End of "## Goals" (before its trailing newline) — lead only.
    expect(ownLinePadding('## Goals\nnext', 8)).toEqual({ leading: '\n', trailing: '' });
  });

  it('adds no leading newline at the start of the document', () => {
    expect(ownLinePadding('abc', 0)).toEqual({ leading: '', trailing: '\n' });
  });

  it('adds no trailing newline at the end of the document', () => {
    expect(ownLinePadding('abc', 3)).toEqual({ leading: '\n', trailing: '' });
  });

  it('adds nothing when the position already sits on a blank line', () => {
    // "a\n\nb" — pos 2 is between the two newlines.
    expect(ownLinePadding('a\n\nb', 2)).toEqual({ leading: '', trailing: '' });
  });

  it('adds only a trailing newline right after an existing newline', () => {
    expect(ownLinePadding('ab\ncd', 3)).toEqual({ leading: '', trailing: '\n' });
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

  it('removePlaceholder deletes the placeholder and its own-line padding', () => {
    // Insert `\n` + placeholder + `\n` at pos 5, as runUpload does for
    // an image dropped mid-line.
    insertPlaceholder(view, 5, `\n${buildPlaceholderText('u1', 'a.png', 0, true)}\n`);
    removePlaceholder(view, 'u1', 1, 1);
    expect(view.state.doc.toString()).toBe('hello world');
  });

  it('removePlaceholder deletes only the token when no padding was added', () => {
    insertPlaceholder(view, 5, buildPlaceholderText('u2', 'a.png', 0, true));
    removePlaceholder(view, 'u2', 0, 0);
    expect(view.state.doc.toString()).toBe('hello world');
  });

  it('removePlaceholder is a no-op when the placeholder has vanished', () => {
    removePlaceholder(view, 'gone', 1, 1);
    expect(view.state.doc.toString()).toBe('hello world');
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

/**
 * feature-auth-cookie-fallback-scope AC-3 — `uploadAttachment`'s
 * `XMLHttpRequest` upload must never fire when no access token is loaded:
 * `POST /attachments/upload` is not one of the three headerless attachment
 * delivery routes (`createAttachmentAuth` only accepts the
 * `crowi.accessToken` cookie for GET/HEAD by-id / original / by-key), so it
 * recovers a token through the same single-flight refresh `apiFetch` uses,
 * and never constructs the `XMLHttpRequest` at all when that can't resolve
 * one. Exercises the real `getAccessToken` / `acquireRefreshedToken` (no
 * module mocking, matching `drop-handler.test.ts` / `paste-handler.test.ts`
 * — only `fetch` and `XMLHttpRequest` are stubbed).
 */
describe('uploadAttachment — token-missing send-avoidance', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let xhrInstances: number;

  class FakeXHR {
    status = 200;
    responseText = JSON.stringify({ url: '/api/attachments/x', filename: 'a.png', mimeType: 'image/png', sizeBytes: 4 });
    upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    headers: Record<string, string> = {};
    constructor() {
      xhrInstances += 1;
    }
    open(): void {}
    setRequestHeader(name: string, value: string): void {
      this.headers[name] = value;
    }
    send(): void {
      this.onload?.();
    }
  }

  beforeEach(() => {
    xhrInstances = 0;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const file = new File([new Uint8Array(4)], 'a.png', { type: 'image/png' });

  it('fails closed — never constructs an XMLHttpRequest — when no access token and no refresh token', async () => {
    await expect(uploadAttachment(file, 'a.png', 'page-1', 'dnd', () => {})).rejects.toThrow('Authentication is required.');
    expect(xhrInstances).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recovers the token through the existing refresh path before opening the XHR', async () => {
    localStorage.setItem('refreshToken', 'refresh-1');
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: 'fresh-access', refreshToken: 'refresh-2', expiresIn: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const outcome = await uploadAttachment(file, 'a.png', 'page-1', 'dnd', () => {});

    expect(outcome.url).toBe('/api/attachments/x');
    expect(xhrInstances).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the /auth/refresh call
    expect(localStorage.getItem('accessToken')).toBe('fresh-access');
  });

  it('sends the request with the existing token directly when one is already loaded (unchanged behaviour)', async () => {
    localStorage.setItem('accessToken', 'existing-access');

    const outcome = await uploadAttachment(file, 'a.png', 'page-1', 'dnd', () => {});

    expect(outcome.url).toBe('/api/attachments/x');
    expect(xhrInstances).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
