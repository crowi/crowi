import type { EditorView } from '@codemirror/view';
import { API_BASE_URL } from '@/lib/api-client';
import { getAccessToken } from '@/lib/auth-token';

/**
 * RFC-0004 Phase 6/7 — progress-placeholder lifecycle shared by the
 * paste handler (Phase 6) and the drag-and-drop handler (Phase 7).
 *
 * When a file upload starts, the editor splices a GitHub-style
 * `![Uploading name (0%)…](#u=<id>)` placeholder into the document at
 * the cursor. As the upload streams, the percentage is updated in
 * place; on completion the whole placeholder token is replaced with the
 * final `![name](url)` (success) or `![Upload failed: name](#)`
 * (failure).
 *
 * Every mutation is a normal CodeMirror transaction. In a collaborative
 * editor `yCollab` intercepts those transactions and turns them into
 * Yjs deltas, so the placeholder + progress updates also propagate to
 * other connected collaborators (RFC §"Progress percentage rendering").
 *
 * **Replacement is keyed by upload id, not filename** (RFC §"Multiple
 * uploads in flight"): the id is embedded in the placeholder's link
 * target (`](#u=<id>)`). Two concurrent uploads of `screenshot.png`
 * therefore get two distinct, individually-addressable placeholders and
 * cannot be confused when they finish out of order.
 *
 * The pure text helpers (`buildPlaceholderText`, `buildSuccessText`,
 * `buildFailureText`, `findPlaceholderRange`) are exported so the
 * placeholder grammar is unit-testable without mounting an editor.
 */

/** Editor intent forwarded to the upload endpoint for telemetry. */
export type UploadIntent = 'paste' | 'dnd';

/** Result of a completed upload, as returned by `/attachments/upload`. */
export interface UploadOutcome {
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/** Marker prefix for the upload-id fragment embedded in a placeholder link. */
const ID_FRAGMENT_PREFIX = '#u=';

/** Counter feeding `newUploadId` — unique within the tab's lifetime. */
let uploadIdSeq = 0;

/** Mint a fresh, collision-free upload id for one in-flight upload. */
export function newUploadId(): string {
  uploadIdSeq += 1;
  return `${Date.now().toString(36)}-${uploadIdSeq.toString(36)}`;
}

/**
 * Auto-generate the paste filename per RFC §"Image paste" — the
 * `pasted-{timestamp}.{ext}` shape. `ext` is derived from the blob's
 * MIME type (falls back to `png`).
 */
export function generatePastedFilename(mimeType: string): string {
  const ext = MIME_TO_EXT[mimeType] ?? 'png';
  return `pasted-${Date.now()}.${ext}`;
}

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/**
 * Strip Markdown bracket characters from a filename before it is spliced
 * into a placeholder / reference token.
 *
 * `findPlaceholderRange` locates a placeholder by walking back from the
 * `](#u=<id>)` tail to the nearest `[`, assuming the placeholder text
 * itself contains no brackets. A user-supplied drag-and-drop filename
 * can legitimately contain `[` / `]` (`paste`'s auto-generated names
 * never do), which would break that scan and the resulting
 * `[name](url)` link syntax. `[` / `]` are replaced with `(` / `)` so
 * the displayed name stays readable while the bracket grammar is safe.
 */
export function sanitizeFilename(filename: string): string {
  return filename.replace(/\[/g, '(').replace(/\]/g, ')');
}

/**
 * The in-progress placeholder text, e.g.
 * `![Uploading pasted-1.png (37%)…](#u=abc-1)`. Non-image files use the
 * `[…]` (link) form rather than `![…]` (image) so the rendered Markdown
 * matches the eventual reference shape.
 */
export function buildPlaceholderText(uploadId: string, filename: string, percent: number, isImage: boolean): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const bang = isImage ? '!' : '';
  return `${bang}[Uploading ${filename} (${clamped}%)…](${ID_FRAGMENT_PREFIX}${uploadId})`;
}

/** Final success token: `![name](url)` for images, `[name](url)` otherwise. */
export function buildSuccessText(filename: string, url: string, isImage: boolean): string {
  const bang = isImage ? '!' : '';
  return `${bang}[${filename}](${url})`;
}

/** Static failure marker (RFC §"Upload fails mid-operation"). */
export function buildFailureText(filename: string, isImage: boolean): string {
  const bang = isImage ? '!' : '';
  return `${bang}[Upload failed: ${filename}](${ID_FRAGMENT_PREFIX}done)`;
}

/**
 * Locate the placeholder for `uploadId` in `doc`. The placeholder is the
 * whole `[…](#u=<id>)` (optionally `!`-prefixed) token; we find the
 * `](#u=<id>)` tail then walk back to the matching `[` (or `![`).
 * Returns `null` when the placeholder is no longer present (e.g. a
 * collaborator deleted it mid-upload).
 */
export function findPlaceholderRange(doc: string, uploadId: string): { from: number; to: number } | null {
  const tail = `](${ID_FRAGMENT_PREFIX}${uploadId})`;
  const tailIdx = doc.indexOf(tail);
  if (tailIdx < 0) return null;
  // Walk back to the opening `[` that has no nested `[` / `]` between it
  // and the tail (the placeholder text never contains brackets itself).
  const openBracket = doc.lastIndexOf('[', tailIdx);
  if (openBracket < 0) return null;
  const from = openBracket > 0 && doc[openBracket - 1] === '!' ? openBracket - 1 : openBracket;
  return { from, to: tailIdx + tail.length };
}

/**
 * Insert `text` at `pos` and return the absolute offset just after it.
 * The follow-up replacements re-locate the placeholder by id, so the
 * caller does not need to track positions across collaborator edits.
 */
export function insertPlaceholder(view: EditorView, pos: number, text: string): void {
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
  });
}

/**
 * Replace the placeholder for `uploadId` with `text`. No-op when the
 * placeholder has vanished. Used both for the in-place percentage
 * updates and the final success / failure swap.
 */
export function replacePlaceholder(view: EditorView, uploadId: string, text: string): void {
  const range = findPlaceholderRange(view.state.doc.toString(), uploadId);
  if (!range) return;
  view.dispatch({ changes: { from: range.from, to: range.to, insert: text } });
}

/** Percentage step below which a progress update is throttled away. */
const PROGRESS_STEP = 5;
/** Minimum interval between progress updates regardless of step. */
const PROGRESS_INTERVAL_MS = 500;

/**
 * Build a throttled progress callback for one upload. Updates the
 * placeholder percentage only when the percent advanced ≥ 5 points OR
 * ≥ 500 ms elapsed since the last write (RFC §"Progress percentage
 * rendering") — this caps the Yjs traffic a long upload generates.
 * `100%` always flushes so the bar visibly completes.
 */
export function makeProgressUpdater(view: EditorView, uploadId: string, filename: string, isImage: boolean): (percent: number) => void {
  let lastPercent = 0;
  // Seed `lastAt` with the construction time — the placeholder is
  // already showing `0%`, so the first 500 ms window starts now and a
  // tiny early progress tick (< 5%) is throttled rather than flushed.
  let lastAt = Date.now();
  return (percent: number) => {
    const now = Date.now();
    const advancedEnough = percent - lastPercent >= PROGRESS_STEP;
    const waitedEnough = now - lastAt >= PROGRESS_INTERVAL_MS;
    if (percent < 100 && !advancedEnough && !waitedEnough) return;
    lastPercent = percent;
    lastAt = now;
    replacePlaceholder(view, uploadId, buildPlaceholderText(uploadId, filename, percent, isImage));
  };
}

/**
 * POST a file to `/api/v2/attachments/upload` with browser-side upload
 * progress. ts-rest's `fetch` transport cannot surface upload progress,
 * so this uses `XMLHttpRequest` directly — `xhr.upload.onprogress` is
 * the only cross-browser way to observe a multipart upload streaming
 * out. The endpoint, field names, and error envelope all match the
 * `apiClient.attachment.uploadAttachment` contract.
 *
 * Resolves with the `UploadOutcome` on 200; rejects with an `Error`
 * whose `.message` is the server-supplied (or generic) message on any
 * non-200, so the caller can surface it in a toast.
 */
export function uploadAttachment(
  file: File,
  filename: string,
  pageId: string,
  intent: UploadIntent,
  onProgress: (percent: number) => void,
): Promise<UploadOutcome> {
  return new Promise<UploadOutcome>((resolve, reject) => {
    const url = `${UPLOAD_BASE_URL}/attachments/upload`;

    const form = new FormData();
    form.append('file', file, filename);
    form.append('pageId', pageId);
    form.append('intent', intent);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    const accessToken = getAccessToken();
    if (accessToken) xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress((event.loaded / event.total) * 100);
    };

    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON body — fall through to the generic message */
      }
      if (xhr.status === 200 && body && typeof body === 'object') {
        resolve(body as UploadOutcome);
        return;
      }
      const message =
        body && typeof body === 'object' && 'message' in body && typeof (body as { message: unknown }).message === 'string'
          ? (body as { message: string }).message
          : 'Upload failed.';
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error('Upload failed: network error.'));
    xhr.onabort = () => reject(new Error('Upload aborted.'));

    xhr.send(form);
  });
}

/** Base URL for the upload XHR — the `/api/v2` mount under the shared api host. */
const UPLOAD_BASE_URL = `${API_BASE_URL}/api/v2`;

/**
 * Drive one file upload end-to-end against an `EditorView`: insert the
 * placeholder at `pos`, stream progress into it, and swap in the final
 * success / failure token. Shared verbatim by paste (Phase 6) and
 * drag-and-drop (Phase 7) — the only per-feature difference is `intent`.
 *
 * The `filename` is sanitised before it ever enters the document
 * ({@link sanitizeFilename}): a drag-and-drop file can carry `[` / `]`
 * in its name, which would corrupt the placeholder bracket grammar
 * `findPlaceholderRange` relies on. The original `File` is still sent to
 * the server verbatim — only the displayed token text is sanitised.
 */
export async function runUpload(view: EditorView, file: File, filename: string, pos: number, pageId: string, intent: UploadIntent): Promise<void> {
  const isImage = file.type.startsWith('image/');
  const uploadId = newUploadId();
  const displayName = sanitizeFilename(filename);

  insertPlaceholder(view, pos, buildPlaceholderText(uploadId, displayName, 0, isImage));
  const onProgress = makeProgressUpdater(view, uploadId, displayName, isImage);

  try {
    const outcome = await uploadAttachment(file, filename, pageId, intent, onProgress);
    replacePlaceholder(view, uploadId, buildSuccessText(displayName, outcome.url, isImage));
  } catch {
    replacePlaceholder(view, uploadId, buildFailureText(displayName, isImage));
  }
}
