import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type NotifyPayload, setNotifyBackend } from '@/lib/notify';
import { _resetAttachmentMaxBytesForTesting, classifyFiles, DND_ACTIVE_CLASS, DND_MAX_FILES, dropHandler } from './drop-handler';
import { sanitizeFilename } from './upload-placeholder';
import { isImageFile } from './upload-policy';

/**
 * RFC-0004 Phase 7 — unit tests for the drag-and-drop upload handler:
 * the pure file-classification logic (size cap / count cap / type
 * allow-list), filename sanitisation, the drop DOM-event behaviour
 * (highlight, serial upload, toasts), and read-only suppression.
 *
 * AC-8 — `dropHandler()` fetches `GET /attachments/upload-policy` on mount
 * (via `@/lib/api-client`'s `apiClient`, mocked below) and `classifyFiles`
 * uses the resolved `maxBytes.attachment` instead of a hard-coded constant.
 * `apiBaseUrl` / `acquireRefreshedToken` (used for real by `runUpload` →
 * `sendUpload`, which talks to the upload XHR stub below, NOT `apiClient`)
 * are kept as their real implementations via `importOriginal`.
 */

const DEFAULT_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

/** Shape of the (mocked) `Response` `ensureAttachmentMaxBytesLoaded` reads. */
type UploadPolicyFetchResult = { ok: boolean; json: () => Promise<{ maxBytes?: { attachment?: number } }> };

const uploadPolicyGet = vi.fn<() => Promise<UploadPolicyFetchResult>>(async () => ({
  ok: true,
  json: async () => ({ maxBytes: { attachment: DEFAULT_ATTACHMENT_MAX_BYTES } }),
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    apiClient: {
      attachments: {
        'upload-policy': { $get: () => uploadPolicyGet() },
      },
    },
  };
});

/** Flush the microtask queue enough times for `ensureAttachmentMaxBytesLoaded`'s `.then(async ...)` chain to settle. */
async function flushPolicyFetch(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  _resetAttachmentMaxBytesForTesting();
  uploadPolicyGet.mockClear();
  uploadPolicyGet.mockImplementation(async () => ({ ok: true, json: async () => ({ maxBytes: { attachment: DEFAULT_ATTACHMENT_MAX_BYTES } }) }));
});

/** Build a `File` of `size` bytes with the given name + MIME type. */
function makeFile(name: string, type: string, size = 10): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe('isImageFile', () => {
  it('is true for image MIME types', () => {
    expect(isImageFile(makeFile('a.png', 'image/png'))).toBe(true);
    expect(isImageFile(makeFile('a.svg', 'image/svg+xml'))).toBe(true);
  });

  it('is false for non-image files', () => {
    expect(isImageFile(makeFile('a.pdf', 'application/pdf'))).toBe(false);
    expect(isImageFile(makeFile('a.zip', 'application/zip'))).toBe(false);
  });
});

describe('sanitizeFilename', () => {
  it('replaces Markdown brackets so the placeholder grammar stays intact', () => {
    expect(sanitizeFilename('photo [final].png')).toBe('photo (final).png');
    expect(sanitizeFilename('a]b[c.pdf')).toBe('a)b(c.pdf');
  });

  it('leaves bracket-free names untouched', () => {
    expect(sanitizeFilename('pasted-1717891234.png')).toBe('pasted-1717891234.png');
  });
});

describe('classifyFiles', () => {
  it('accepts images, documents and archives within the size cap', () => {
    const files = [
      makeFile('a.png', 'image/png'),
      makeFile('b.pdf', 'application/pdf'),
      makeFile('c.txt', 'text/plain'),
      makeFile('d.csv', 'text/csv'),
      makeFile('e.zip', 'application/zip'),
    ];
    const result = classifyFiles(files);
    expect(result.accepted).toHaveLength(5);
    expect(result.rejected).toHaveLength(0);
    expect(result.tooMany).toBe(false);
  });

  it('accepts .md files reported with an empty / generic MIME type', () => {
    const result = classifyFiles([makeFile('notes.md', ''), makeFile('data.csv', 'application/octet-stream')]);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);
  });

  it('feature-attachment-upload-policy: accepts ANY empty-`File.type` drop, mirroring the server’s exact normalization — regression for the attach-button-vs-D&D divergence found in review (a `.docx` reported with an empty MIME type used to pass the attach button, which normalizes empty types the same way, while being rejected here)', () => {
    const result = classifyFiles([makeFile('report.docx', ''), makeFile('unknown-type-file', '')]);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);
  });

  it('feature-attachment-upload-policy: accepts business document types the old narrower D&D-only allow-list rejected (docx / pptx / html) — the same policy the attach button and paste share', () => {
    const files = [
      makeFile('report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      makeFile('slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
      makeFile('page.html', 'text/html'),
    ];
    const result = classifyFiles(files);
    expect(result.accepted).toHaveLength(3);
    expect(result.rejected).toHaveLength(0);
  });

  it('rejects a disallowed file type', () => {
    const result = classifyFiles([makeFile('app.exe', 'application/x-msdownload')]);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toEqual([{ file: expect.any(File), reason: 'disallowed_type' }]);
  });

  it('does not reject on size when no upload-policy fetch has resolved yet — the server remains the size backstop rather than a guessed local ceiling', () => {
    const big = makeFile('huge.png', 'image/png', DEFAULT_ATTACHMENT_MAX_BYTES + 1);
    const result = classifyFiles([big]);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('flags tooMany when more than 5 files are dropped', () => {
    const files = Array.from({ length: DND_MAX_FILES + 1 }, (_, i) => makeFile(`f${i}.png`, 'image/png'));
    const result = classifyFiles(files).tooMany;
    expect(result).toBe(true);
  });

  it('does not flag tooMany at exactly the 5-file limit', () => {
    const files = Array.from({ length: DND_MAX_FILES }, (_, i) => makeFile(`f${i}.png`, 'image/png'));
    expect(classifyFiles(files).tooMany).toBe(false);
  });
});

describe('dropHandler DOM behaviour', () => {
  let view: EditorView;
  let toasts: NotifyPayload[];
  /** Resolvers for each in-flight stub upload, so a test can drain them. */
  let pendingUploads: Array<() => void>;

  /** Build a `DataTransfer`-shaped object jsdom can carry on a DragEvent. */
  function dataTransfer(files: File[]): DataTransfer {
    return {
      files: files as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
      types: files.length > 0 ? ['Files'] : [],
      dropEffect: 'none',
      effectAllowed: 'all',
    } as unknown as DataTransfer;
  }

  function fireDrag(type: 'dragenter' | 'dragover' | 'dragleave' | 'drop', files: File[]): DragEvent {
    const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer(files) });
    view.contentDOM.dispatchEvent(event);
    return event;
  }

  beforeEach(() => {
    toasts = [];
    pendingUploads = [];
    setNotifyBackend({
      show: (payload) => toasts.push(payload),
      dismiss: () => {},
    });

    // feature-auth-cookie-fallback-scope — `uploadAttachment` now fails
    // closed (no XHR at all) when no access token is available, rather than
    // firing the request headerless. A token here keeps these tests on the
    // SAME synchronous timing they rely on below (`pendingUploads` asserted
    // immediately after `fireDrag`, with no `await` in between): with a
    // token present the token-recovery branch's `await` is never reached,
    // so `xhr.send()` still runs synchronously inside the same tick.
    localStorage.setItem('accessToken', 'test-access-token');

    // Stub XMLHttpRequest so `runUpload`'s upload resolves without a
    // network round-trip. Each `send` parks a resolver in `pendingUploads`
    // — the test drains them to assert serial ordering.
    class FakeXHR {
      status = 200;
      responseText = JSON.stringify({ url: '/api/attachments/x', filename: 'f', mimeType: 'image/png', sizeBytes: 1 });
      upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open(): void {}
      setRequestHeader(): void {}
      send(): void {
        pendingUploads.push(() => this.onload?.());
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
  });

  afterEach(() => {
    setNotifyBackend(null);
    vi.unstubAllGlobals();
    localStorage.clear();
    view?.destroy();
  });

  /** Mount an editor with the drop handler; `readonly` toggles suppression. */
  function mount(readonly = false): void {
    view = new EditorView({
      state: EditorState.create({
        doc: 'start',
        extensions: [dropHandler({ pageId: 'page-1' }), readonly ? EditorState.readOnly.of(true) : []],
      }),
    });
  }

  it('adds the highlight class on dragenter and clears it on drop', async () => {
    mount();
    fireDrag('dragenter', [makeFile('a.png', 'image/png')]);
    expect(view.dom.classList.contains(DND_ACTIVE_CLASS)).toBe(true);

    fireDrag('drop', [makeFile('a.png', 'image/png')]);
    expect(view.dom.classList.contains(DND_ACTIVE_CLASS)).toBe(false);
    pendingUploads.forEach((resolve) => resolve());
    await Promise.resolve();
  });

  it('clears the highlight on dragleave', () => {
    mount();
    fireDrag('dragenter', [makeFile('a.png', 'image/png')]);
    fireDrag('dragleave', []);
    expect(view.dom.classList.contains(DND_ACTIVE_CLASS)).toBe(false);
  });

  it('uploads dropped files serially — one placeholder at a time', async () => {
    mount();
    fireDrag('drop', [makeFile('one.png', 'image/png'), makeFile('two.pdf', 'application/pdf')]);

    // Serial: only the first upload has started; its placeholder is in.
    expect(pendingUploads).toHaveLength(1);
    expect(view.state.doc.toString()).toContain('Uploading one.png');
    expect(view.state.doc.toString()).not.toContain('Uploading two.pdf');

    // Drain the first upload → the second one starts.
    pendingUploads[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(pendingUploads).toHaveLength(2);
    expect(view.state.doc.toString()).toContain('Uploading two.pdf');
    pendingUploads[1]();
    await Promise.resolve();
  });

  it('inserts an image as ![](url) and a document as [](url)', async () => {
    mount();
    fireDrag('drop', [makeFile('pic.png', 'image/png')]);
    expect(view.state.doc.toString()).toContain('![Uploading pic.png');
    pendingUploads[0]();
    await Promise.resolve();

    view.dispatch({ selection: { anchor: view.state.doc.length } });
    fireDrag('drop', [makeFile('doc.pdf', 'application/pdf')]);
    // Non-image placeholder has no `!` prefix.
    expect(view.state.doc.toString()).toMatch(/[^!]\[Uploading doc\.pdf/);
    pendingUploads.forEach((resolve) => resolve());
    await Promise.resolve();
  });

  it('toasts and aborts the whole drop when more than 5 files are dropped', () => {
    mount();
    const files = Array.from({ length: 6 }, (_, i) => makeFile(`f${i}.png`, 'image/png'));
    fireDrag('drop', files);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe('Drop up to 5 files at a time.');
    // Nothing uploaded.
    expect(pendingUploads).toHaveLength(0);
    expect(view.state.doc.toString()).toBe('start');
  });

  it('toasts a disallowed type but still uploads the allowed files', async () => {
    mount();
    fireDrag('drop', [makeFile('ok.png', 'image/png'), makeFile('bad.exe', 'application/x-msdownload')]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain('cannot be uploaded');
    // The allowed image still uploads.
    expect(pendingUploads).toHaveLength(1);
    expect(view.state.doc.toString()).toContain('Uploading ok.png');
    pendingUploads[0]();
    await Promise.resolve();
  });

  it('suppresses the highlight on dragenter when read-only', () => {
    mount(true);
    fireDrag('dragenter', [makeFile('a.png', 'image/png')]);
    expect(view.dom.classList.contains(DND_ACTIVE_CLASS)).toBe(false);
  });

  it('ignores the drop and shows a permission toast when read-only', () => {
    mount(true);
    fireDrag('drop', [makeFile('a.png', 'image/png')]);
    expect(pendingUploads).toHaveLength(0);
    expect(view.state.doc.toString()).toBe('start');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe("You don't have edit permission for this page.");
  });

  describe('AC-8 — policy-driven size limit', () => {
    it('fetches the upload policy on mount', () => {
      mount();
      expect(uploadPolicyGet).toHaveBeenCalledTimes(1);
    });

    it('rejects a file over the server-published limit and accepts one under it, once the policy fetch resolves', async () => {
      const policyMaxBytes = 3 * 1024 * 1024;
      uploadPolicyGet.mockImplementation(async () => ({ ok: true, json: async () => ({ maxBytes: { attachment: policyMaxBytes } }) }));
      mount();
      await flushPolicyFetch();

      fireDrag('drop', [makeFile('small.png', 'image/png', 2 * 1024 * 1024), makeFile('big.png', 'image/png', 4 * 1024 * 1024)]);

      expect(toasts).toHaveLength(1);
      expect(toasts[0].message).toBe('big.png is too large to upload (max 3 MB).');
      expect(pendingUploads).toHaveLength(1);
      expect(view.state.doc.toString()).toContain('Uploading small.png');
      pendingUploads[0]();
      await Promise.resolve();
    });

    it('renders a sub-1MB limit in KB rather than rounding it down to "0 MB"', async () => {
      const policyMaxBytes = 512 * 1024;
      uploadPolicyGet.mockImplementation(async () => ({ ok: true, json: async () => ({ maxBytes: { attachment: policyMaxBytes } }) }));
      mount();
      await flushPolicyFetch();

      fireDrag('drop', [makeFile('big.png', 'image/png', 1024 * 1024)]);

      expect(toasts).toHaveLength(1);
      expect(toasts[0].message).toBe('big.png is too large to upload (max 512 KB).');
    });

    it('applies no local size gate when the policy fetch fails (old server / network error) — the file still goes to the server, which is the real enforcement point', async () => {
      uploadPolicyGet.mockImplementation(async () => ({ ok: false, json: async () => ({}) }));
      mount();
      await flushPolicyFetch();

      const big = makeFile('huge.png', 'image/png', DEFAULT_ATTACHMENT_MAX_BYTES + 1);
      fireDrag('drop', [big]);

      expect(toasts).toHaveLength(0);
      expect(pendingUploads).toHaveLength(1);
      expect(view.state.doc.toString()).toContain('Uploading huge.png');
      pendingUploads[0]();
      await Promise.resolve();
    });

    it('applies no local size gate before the policy fetch has resolved at all (still in flight) — an operator-lowered limit must not be silently ignored in favour of a guessed number', () => {
      uploadPolicyGet.mockImplementation(() => new Promise(() => {}));
      mount();
      // Deliberately no `await flushPolicyFetch()` — the fetch never settles
      // within this test.

      const big = makeFile('huge.png', 'image/png', DEFAULT_ATTACHMENT_MAX_BYTES + 1);
      fireDrag('drop', [big]);

      expect(toasts).toHaveLength(0);
      expect(pendingUploads).toHaveLength(1);
      expect(view.state.doc.toString()).toContain('Uploading huge.png');
    });

    it('retries the policy fetch on a later editor mount after an earlier fetch failed, instead of staying permanently latched off', async () => {
      uploadPolicyGet.mockImplementationOnce(async () => ({ ok: false, json: async () => ({}) }));
      dropHandler({ pageId: 'page-1' }); // first "mount" — fetch fails
      await flushPolicyFetch();
      expect(uploadPolicyGet).toHaveBeenCalledTimes(1);

      uploadPolicyGet.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ maxBytes: { attachment: DEFAULT_ATTACHMENT_MAX_BYTES } }) }));
      dropHandler({ pageId: 'page-1' }); // second "mount" — must retry, not stay latched
      await flushPolicyFetch();
      expect(uploadPolicyGet).toHaveBeenCalledTimes(2);
    });
  });
});
