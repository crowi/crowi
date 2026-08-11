import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { apiClient } from '@/lib/api-client';
import { notify } from '@/lib/notify';
import { runUpload } from './upload-placeholder';
import { disallowedTypeMessage, isUploadAllowedType } from './upload-policy';

/**
 * RFC-0004 Phase 7 — CodeMirror 6 drag-and-drop upload handler.
 *
 * Wires `dragenter` / `dragover` / `drop` on the editor DOM so dropping
 * one or more files uploads them to `/api/attachments/upload` and
 * splices a progress placeholder at the drop position (the same
 * lifecycle the paste handler uses — see `upload-placeholder.ts`). The
 * `drop` handler `preventDefault`s the event, which suppresses
 * CodeMirror's native drop handling — including the caret move — so it
 * resolves the drop position itself from the event coordinates
 * (`posAtCoords`) and moves the caret there before uploading
 * (RFC §"Drop position").
 *
 * Three concerns layered on top of the bare upload:
 *   1. **Visual feedback** — a subtle outline highlights the editor on
 *      `dragenter` and clears immediately on `drop` / `dragleave`.
 *   2. **D&D limits** (RFC §"D&D limits") — at most 5 files per drop, each
 *      ≤ the server's published upload size limit (`classifyFiles` has no
 *      hard-coded ceiling of its own; it reads `GET
 *      /attachments/upload-policy` once per editor mount, see
 *      {@link ensureAttachmentMaxBytesLoaded}. Until that resolves, the
 *      size check is skipped entirely rather than guessed at — an
 *      operator-lowered limit must never be silently ignored by a stale
 *      local number, so the server remains the enforcement backstop for
 *      that window), and the unified upload MIME allow-list (the SAME
 *      allow-list the attach button / paste share, so a file's fate does
 *      not depend on which affordance uploaded it). A violated limit
 *      aborts that one file with a toast; other files in the same drop
 *      still upload.
 *   3. **Read-only suppression** (RFC §"Read-only mode") — when the
 *      editor is read-only (RFC-0003 20-editor cap reached, or no edit
 *      permission) drag-and-drop is fully disabled: no highlight, the
 *      drop is ignored, and a permission toast is shown.
 *
 * The pure helper `classifyFiles` is exported so the limit logic is
 * unit-testable without a DOM / `EditorView`; the type policy it applies
 * lives in `upload-policy.ts`, shared with the paste handler.
 */

/**
 * The currently-known per-file size ceiling, kept in sync by
 * {@link ensureAttachmentMaxBytesLoaded}. `null` means "not yet resolved" —
 * no successful policy fetch has completed — and is deliberately NOT
 * treated as "assume the documented default": an operator-lowered
 * `CROWI_UPLOAD_MAX_BYTES` must never be silently ignored in favour of a
 * hard-coded number the client merely hopes is still accurate.
 * {@link classifyFiles} skips the size check entirely while this is `null`,
 * leaving the server as the authority for that window (a request the
 * server actually rejects still 413s — this only affects the CLIENT-SIDE
 * pre-flight UX, not enforcement).
 */
let attachmentMaxBytes: number | null = null;
let policyFetchStarted = false;

/**
 * Fetch `GET /attachments/upload-policy` and cache `maxBytes.attachment`
 * for {@link classifyFiles}. Idempotent while in flight: concurrent calls
 * (e.g. two editors mounting close together) issue only one request. A
 * failed attempt (network error, non-2xx, an old server predating this
 * endpoint) leaves {@link attachmentMaxBytes} at `null` — see its doc
 * comment for why that must not fall back to a guessed number — and
 * resets the latch so the NEXT call (a later editor mount) retries rather
 * than giving up for the rest of the page's lifetime. The whole body is
 * wrapped in a `try` — a synchronous throw (e.g. a test double for
 * `apiClient` that doesn't implement this route) must degrade exactly like
 * a failed fetch, never abort editor mounting.
 */
function ensureAttachmentMaxBytesLoaded(): void {
  if (policyFetchStarted) return;
  policyFetchStarted = true;
  try {
    apiClient.attachments['upload-policy']
      .$get()
      .then(async (response) => {
        if (!response.ok) {
          policyFetchStarted = false;
          return;
        }
        const body = (await response.json()) as { maxBytes?: { attachment?: number } };
        const attachment = body.maxBytes?.attachment;
        if (typeof attachment === 'number' && attachment > 0) {
          attachmentMaxBytes = attachment;
        } else {
          policyFetchStarted = false;
        }
      })
      .catch(() => {
        policyFetchStarted = false;
      });
  } catch {
    policyFetchStarted = false;
  }
}

/** Test-only: reset the cached policy value + fetch latch between tests. */
export function _resetAttachmentMaxBytesForTesting(): void {
  attachmentMaxBytes = null;
  policyFetchStarted = false;
}

/**
 * Human-readable rendering of a byte count, for the "too large" toast.
 * Whole-unit rounding reads fine for realistic limits (tens of MB), but
 * `Math.round` on a value like 1.6 MiB would display "2 MB" — a number the
 * server would actually reject. `Math.floor` only ever understates the
 * limit, never overstates it. Picks whichever of B / KB / MB reads as a
 * non-zero whole number, so an operator-lowered limit under 1 MB doesn't
 * collapse to a misleading "0 MB".
 */
function formatMaxSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Math.floor(mb)} MB`;
  const kb = bytes / 1024;
  if (kb >= 1) return `${Math.floor(kb)} KB`;
  return `${bytes} B`;
}

/** Per-drop file-count ceiling — RFC §"D&D limits". */
export const DND_MAX_FILES = 5;

/**
 * A file rejected by the allow-list / size cap, with the reason for the
 * toast. `limitBytes` is only present for `'too_large'` (a discriminated
 * union, not an optional field on a flat shape) so the caller building the
 * toast message never needs to null-check a value that, by construction,
 * always accompanies that reason.
 */
export type RejectedFile = { file: File; reason: 'too_large'; limitBytes: number } | { file: File; reason: 'disallowed_type' };

/** Outcome of validating a dropped `FileList` against the D&D limits. */
export interface ClassifiedDrop {
  /** Files that passed both the size cap and the type allow-list. */
  accepted: File[];
  /** Files that failed, with the failure reason. */
  rejected: RejectedFile[];
  /** True when the drop contained more than {@link DND_MAX_FILES} files. */
  tooMany: boolean;
}

/**
 * Validate a dropped `FileList` against the D&D limits. Pure (reads the
 * module-level {@link attachmentMaxBytes} cache, but performs no I/O
 * itself): does no uploading. The caller decides — on `tooMany` it aborts
 * the whole drop (RFC: "Drop up to 5 files at a time."); otherwise it
 * uploads `accepted` and toasts each `rejected` file.
 */
export function classifyFiles(files: File[]): ClassifiedDrop {
  const tooMany = files.length > DND_MAX_FILES;
  const accepted: File[] = [];
  const rejected: RejectedFile[] = [];
  for (const file of files) {
    if (attachmentMaxBytes !== null && file.size > attachmentMaxBytes) {
      rejected.push({ file, reason: 'too_large', limitBytes: attachmentMaxBytes });
    } else if (!isUploadAllowedType(file)) {
      rejected.push({ file, reason: 'disallowed_type' });
    } else {
      accepted.push(file);
    }
  }
  return { accepted, rejected, tooMany };
}

/** CSS class toggled on the editor root (`.cm-editor`) while a file drag is over it. */
export const DND_ACTIVE_CLASS = 'cm-dnd-active';

/**
 * Drop-feedback theme: a subtle inset outline on the editor root while a
 * file drag hovers (RFC §"Visual feedback"). Scoped as a CodeMirror
 * `EditorView.theme` so the styling ships with the extension rather than
 * leaking into global CSS — `&` resolves to the `.cm-editor` root that
 * carries {@link DND_ACTIVE_CLASS}.
 */
const dndTheme = EditorView.theme({
  '&.cm-dnd-active': {
    outline: '2px dashed var(--crowi-primary, #2c7a7b)',
    outlineOffset: '-2px',
  },
});

/** Configuration for {@link dropHandler}. */
export interface DropHandlerOptions {
  /**
   * The id of the page being edited — forwarded to the upload endpoint
   * for the write-permission check. Required even for brand-new pages
   * (the draft-page mechanism gives every page a real id from the start).
   */
  pageId: string;
}

/**
 * True when the editor is currently read-only. Read off the live
 * `EditorState` so a mid-session readonly flip (20-editor cap reached
 * after mount) is honoured — `MarkdownEditor` reconfigures the readonly
 * compartment, so `state.readOnly` always reflects the current mode.
 */
function isReadOnly(view: EditorView): boolean {
  return view.state.readOnly;
}

/**
 * Upload `files` one at a time, in OS-reported order (RFC §"Behaviour":
 * "process serially, in the order the OS reports them"). Each upload
 * inserts its placeholder at the *current* cursor; `runUpload` advances
 * the cursor past the inserted placeholder, so successive files stack in
 * order. `runUpload` never throws (failures land in a static error
 * marker), so the loop always drains.
 */
async function uploadSerially(view: EditorView, files: File[], pageId: string): Promise<void> {
  for (const file of files) {
    const pos = view.state.selection.main.from;
    await runUpload(view, file, file.name, pos, pageId);
  }
}

/**
 * Build the drag-and-drop CodeMirror extension. Threaded through
 * `buildExtensions({ dnd })` → `extraExtensions`, after `yCollab` so a
 * placeholder insertion / replacement becomes a Yjs delta.
 *
 * Kicks off {@link ensureAttachmentMaxBytesLoaded} so the editor's size
 * ceiling for THIS mount reflects the server's actual policy by the time
 * the user drops a file (typically well before — the fetch races the
 * user's first interaction, and `classifyFiles` applies no size gate at
 * all until it resolves — see that cache's doc comment).
 */
export function dropHandler(options: DropHandlerOptions): Extension {
  const { pageId } = options;
  ensureAttachmentMaxBytesLoaded();

  return [dndTheme, dndEventHandlers(pageId)];
}

/** The DOM-event half of the drop extension (separated from the theme). */
function dndEventHandlers(pageId: string): Extension {
  return EditorView.domEventHandlers({
    dragenter(event: DragEvent, view: EditorView): boolean {
      // Only react to file drags — a text/selection drag inside the
      // editor must keep CodeMirror's native behaviour.
      if (!hasFiles(event.dataTransfer)) return false;
      // Read-only: no highlight, let the event fall through (the drop
      // itself is rejected below).
      if (isReadOnly(view)) return false;
      view.dom.classList.add(DND_ACTIVE_CLASS);
      return false;
    },

    dragover(event: DragEvent, view: EditorView): boolean {
      if (!hasFiles(event.dataTransfer)) return false;
      if (isReadOnly(view)) return false;
      // Signal a copy cursor. The actual insertion position is resolved
      // in `drop` from the event coordinates — `dragover` does not move
      // the real selection.
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      return false;
    },

    dragleave(_event: DragEvent, view: EditorView): boolean {
      view.dom.classList.remove(DND_ACTIVE_CLASS);
      return false;
    },

    drop(event: DragEvent, view: EditorView): boolean {
      const files = event.dataTransfer ? Array.from(event.dataTransfer.files) : [];
      if (files.length === 0) return false;

      // Clear the highlight immediately, regardless of outcome.
      view.dom.classList.remove(DND_ACTIVE_CLASS);

      // Read-only: ignore the drop entirely + permission toast.
      if (isReadOnly(view)) {
        event.preventDefault();
        notify.warn("You don't have edit permission for this page.");
        return true;
      }

      event.preventDefault();

      const { accepted, rejected, tooMany } = classifyFiles(files);

      // Per-operation count cap aborts the whole drop (RFC §"D&D limits").
      if (tooMany) {
        notify.warn('Drop up to 5 files at a time.');
        return true;
      }

      // Toast each rejected file by its failure reason.
      for (const rejection of rejected) {
        if (rejection.reason === 'too_large') {
          notify.warn(`${rejection.file.name} is too large to upload (max ${formatMaxSize(rejection.limitBytes)}).`);
        } else {
          notify.warn(disallowedTypeMessage(rejection.file));
        }
      }

      if (accepted.length > 0) {
        // Move the caret to where the file was dropped. `preventDefault`
        // above suppressed CodeMirror's native drop handling, so the
        // selection still sits at the pre-drag cursor; without this the
        // placeholder would splice there instead of at the drop point.
        // `posAtCoords` can throw before the view is laid out (or under
        // a headless test DOM) — fall back to the current selection.
        let dropPos: number | null = null;
        try {
          dropPos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        } catch {
          dropPos = null;
        }
        if (dropPos != null) {
          view.dispatch({ selection: { anchor: dropPos } });
        }
        // Fire-and-forget: `uploadSerially` owns the placeholder
        // lifecycle and never throws (per-file failures land in a
        // static marker).
        void uploadSerially(view, accepted, pageId);
      }
      return true;
    },
  });
}

/** True when a drag payload carries files (vs. a text / selection drag). */
function hasFiles(data: DataTransfer | null): boolean {
  if (!data) return false;
  // `types` is the reliable cross-browser signal during dragenter /
  // dragover — `files` is often empty until the actual `drop`.
  return Array.from(data.types).includes('Files');
}
