import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type NotifyPayload, setNotifyBackend } from '@/lib/notify';
import { extractSingleUrl, isInsideLinkSyntax, pasteHandler } from './paste-handler';

/**
 * RFC-0004 Phase 6 — unit tests for the paste handler's pure logic:
 * single-URL detection from a clipboard payload and the "cursor inside
 * link syntax" check that suppresses double-wrapping.
 *
 * feature-attachment-upload-policy adds the clipboard-file half: paste
 * must accept exactly the file types the attach button and drag-and-drop
 * accept (a non-image file used to fall through to the browser's default
 * paste and never upload at all), while still deciding image-embed vs
 * link purely from the file's type.
 */

describe('extractSingleUrl', () => {
  it('returns the URL when the payload is exactly one http(s) URL', () => {
    expect(extractSingleUrl('https://example.com/page')).toBe('https://example.com/page');
    expect(extractSingleUrl('http://example.com')).toBe('http://example.com');
  });

  it('trims surrounding whitespace and trailing newlines', () => {
    expect(extractSingleUrl('  https://example.com/x \n')).toBe('https://example.com/x');
  });

  it('returns null when the payload contains more than a URL', () => {
    expect(extractSingleUrl('see https://example.com here')).toBeNull();
    expect(extractSingleUrl('https://example.com and more text')).toBeNull();
  });

  it('returns null for non-http(s) schemes and non-URLs', () => {
    expect(extractSingleUrl('ftp://example.com/file')).toBeNull();
    expect(extractSingleUrl('javascript:alert(1)')).toBeNull();
    expect(extractSingleUrl('just plain text')).toBeNull();
    expect(extractSingleUrl('')).toBeNull();
  });
});

describe('isInsideLinkSyntax', () => {
  /** Build a markdown EditorState with a fully-realised syntax tree. */
  const stateFor = (doc: string): EditorState => {
    const state = EditorState.create({ doc, extensions: [markdown()] });
    ensureSyntaxTree(state, doc.length, 5000);
    return state;
  };

  it('is true inside a [text](url) link', () => {
    const doc = 'see [the docs](https://example.com) now';
    const state = stateFor(doc);
    // Position inside the URL portion.
    expect(isInsideLinkSyntax(state, doc.indexOf('example'))).toBe(true);
  });

  it('is false in plain prose outside any link', () => {
    const doc = 'just some plain words here';
    const state = stateFor(doc);
    expect(isInsideLinkSyntax(state, 10)).toBe(false);
  });
});

describe('pasteHandler clipboard files', () => {
  let view: EditorView;
  let toasts: NotifyPayload[];
  /** One entry per started upload: the multipart body `runUpload` sent. */
  let uploads: FormData[];
  /** Resolvers for each in-flight stub upload, so a test can drain them. */
  let pendingUploads: Array<() => void>;

  function makeFile(name: string, type: string): File {
    return new File([new Uint8Array(10)], name, { type });
  }

  /** A clipboard payload carrying `files` as `kind: 'file'` items, plus optional text. */
  function clipboardData(files: File[], text = ''): DataTransfer {
    const items = files.map((file) => ({ kind: 'file' as const, type: file.type, getAsFile: () => file }));
    return {
      items: items as unknown as DataTransferItemList,
      files: [] as unknown as FileList,
      types: files.length > 0 ? ['Files'] : ['text/plain'],
      getData: () => text,
    } as unknown as DataTransfer;
  }

  /** A clipboard payload carrying rich text only (`kind: 'string'` items). */
  function richTextClipboard(text: string): DataTransfer {
    const items = [
      { kind: 'string' as const, type: 'text/html', getAsFile: () => null },
      { kind: 'string' as const, type: 'text/plain', getAsFile: () => null },
    ];
    return {
      items: items as unknown as DataTransferItemList,
      files: [] as unknown as FileList,
      types: ['text/html', 'text/plain'],
      getData: () => text,
    } as unknown as DataTransfer;
  }

  function firePaste(data: DataTransfer): ClipboardEvent {
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', { value: data });
    view.contentDOM.dispatchEvent(event);
    return event;
  }

  beforeEach(() => {
    toasts = [];
    uploads = [];
    pendingUploads = [];
    setNotifyBackend({
      show: (payload) => toasts.push(payload),
      dismiss: () => {},
    });

    // feature-auth-cookie-fallback-scope — see the matching comment in
    // `drop-handler.test.ts`'s `beforeEach`: `uploadAttachment` fails closed
    // without a token, and a token here keeps `xhr.send()` synchronous with
    // `firePaste` (no `await` before the `pendingUploads` assertions below).
    localStorage.setItem('accessToken', 'test-access-token');

    // Same stub shape as `drop-handler.test.ts` — `runUpload`'s XHR
    // resolves without a network round-trip, and the test drives when.
    class FakeXHR {
      status = 200;
      responseText = JSON.stringify({ url: '/api/attachments/x', filename: 'f', mimeType: 'text/html', sizeBytes: 1 });
      upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open(): void {}
      setRequestHeader(): void {}
      send(body: FormData): void {
        uploads.push(body);
        pendingUploads.push(() => this.onload?.());
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);

    view = new EditorView({
      state: EditorState.create({ doc: 'start', extensions: [pasteHandler({ pageId: 'page-1' })] }),
    });
    view.dispatch({ selection: { anchor: view.state.doc.length } });
  });

  afterEach(() => {
    setNotifyBackend(null);
    vi.unstubAllGlobals();
    localStorage.clear();
    view?.destroy();
  });

  it('uploads a pasted non-image file and inserts it as a LINK — the same acceptance policy the attach button / drag-and-drop apply (feature-attachment-upload-policy)', async () => {
    const event = firePaste(clipboardData([makeFile('report.html', 'text/html')]));

    expect(event.defaultPrevented).toBe(true);
    expect(pendingUploads).toHaveLength(1);
    // `intent` is not sent to the server: the size cap is a single unified
    // value, independent of it.
    expect(uploads[0].get('intent')).toBeNull();
    // Non-image placeholder / result carry no `!` prefix, and the file
    // keeps its own name (no `pasted-…` rename).
    expect(view.state.doc.toString()).toMatch(/[^!]\[Uploading report\.html/);

    pendingUploads[0]();
    await Promise.resolve();
    expect(view.state.doc.toString()).toContain('[report.html](/api/attachments/x)');
    expect(view.state.doc.toString()).not.toContain('![report.html]');
  });

  it('still uploads a pasted image as an embedded image with a generated pasted-… name', async () => {
    firePaste(clipboardData([makeFile('image.png', 'image/png')]));

    expect(pendingUploads).toHaveLength(1);
    expect(view.state.doc.toString()).toMatch(/!\[Uploading pasted-\d+\.png/);

    pendingUploads[0]();
    await Promise.resolve();
    expect(view.state.doc.toString()).toMatch(/!\[pasted-\d+\.png]\(\/api\/attachments\/x\)/);
  });

  it('rejects a pasted file whose type is not uploadable, with the same wording every other route uses', () => {
    firePaste(clipboardData([makeFile('setup.exe', 'application/x-msdownload')]));

    expect(pendingUploads).toHaveLength(0);
    expect(view.state.doc.toString()).toBe('start');
    expect(toasts).toEqual([expect.objectContaining({ message: 'Files of type application/x-msdownload cannot be uploaded.' })]);
  });

  it('leaves rich-text paste (HTML as a clipboard string, not a file) to CodeMirror', () => {
    firePaste(richTextClipboard('some copied prose'));

    // Copied rich text carries a `text/html` flavour, but as a clipboard
    // STRING — it must not be mistaken for a `text/html` file upload.
    expect(pendingUploads).toHaveLength(0);
    expect(toasts).toHaveLength(0);
    expect(view.state.doc.toString()).not.toContain('Uploading');
  });
});
