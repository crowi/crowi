import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { notify } from '@/lib/notify';
import { generatePastedFilename, runUpload } from './upload-placeholder';
import { disallowedTypeMessage, isImageFile, isUploadAllowedType } from './upload-policy';

/**
 * RFC-0004 Phase 6 — CodeMirror 6 paste handler for the editor.
 *
 * Intercepts the `paste` DOM event for two clipboard data types and
 * leaves everything else to CodeMirror's default paste:
 *
 *   - **Plain URL** (`text/plain` that trims to exactly one well-formed
 *     `http(s)://` URL): if text is selected, wrap it as
 *     `[selected](url)`; otherwise insert the URL verbatim (it autolinks
 *     at render time per RFC-0002) — unless the cursor already sits
 *     inside `[…](…)` link syntax, in which case insert plain to avoid
 *     double-wrapping.
 *   - **File** (a screenshot / an image copied from another app / a file
 *     copied from the OS file manager): drop a progress placeholder and
 *     upload via `/api/attachments/upload`. Images are auto-named
 *     `pasted-{timestamp}.{ext}` and land as `![name](url)`; any other
 *     file keeps its own name and lands as `[name](url)`
 *     (feature-attachment-upload-policy — see `upload-policy.ts` for why
 *     "may it be uploaded" and "is it embedded as an image" are separate
 *     questions, and why paste must answer the first one exactly like the
 *     attach button and drag-and-drop do).
 *
 * Plain text and rich clipboard content are NOT intercepted, so the
 * built-in paste (and therefore CodeMirror's typing-only autocomplete
 * activation) is untouched — pasted `@`/`[[` never opens the dropdown
 * (RFC §"Paste vs autocomplete"). Rich text carrying HTML arrives as
 * `kind === 'string'` clipboard items, not files, so it never reaches the
 * upload branch.
 *
 * The pure helpers (`extractSingleUrl`, `isInsideLinkSyntax`) are
 * exported so the URL detection is unit-testable without a DOM.
 */

/**
 * Return the single well-formed `http(s)` URL `text` consists of, or
 * `null` when `text` (after trimming surrounding whitespace / newlines)
 * is not exactly one URL. Whitespace inside the candidate disqualifies
 * it — a clipboard payload with embedded spaces is prose, not a URL.
 */
export function extractSingleUrl(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * True when `pos` sits inside the label or URL portion of a `[text](url)`
 * link / `![alt](url)` image. Used to suppress URL-paste wrapping so a
 * URL pasted into an existing link is inserted plainly rather than
 * producing a nested `[[x](y)](z)`. Detected via the markdown syntax
 * tree so it tracks the grammar rather than re-scanning text.
 */
export function isInsideLinkSyntax(state: EditorState, pos: number): boolean {
  let node = syntaxTree(state).resolveInner(pos, -1);
  while (node) {
    if (node.name === 'Link' || node.name === 'Image' || node.name === 'URL') return true;
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}

/** Every `File` a clipboard payload carries, in clipboard order. */
function clipboardFiles(data: DataTransfer): File[] {
  const fromItems = Array.from(data.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (fromItems.length > 0) return fromItems;
  // Some browsers expose pasted files only via `files`.
  return Array.from(data.files);
}

/**
 * The single `File` a paste uploads, or `null` when the clipboard carries
 * none. Images win over other files: a rich-text copy that bundles both a
 * screenshot and some other attachment-ish payload should still paste as
 * the image the user sees.
 */
function firstPastedFile(data: DataTransfer): File | null {
  const files = clipboardFiles(data);
  return files.find(isImageFile) ?? files[0] ?? null;
}

/** Configuration for {@link pasteHandler}. */
export interface PasteHandlerOptions {
  /**
   * The id of the page being edited — forwarded to the upload endpoint
   * for the write-permission check. Required even for brand-new pages
   * (the draft-page mechanism gives every page a real id from the start).
   */
  pageId: string;
}

/**
 * Build the paste-handling CodeMirror extension. Threaded through
 * `buildExtensions({ paste })` → `extraExtensions`, after `yCollab` so a
 * placeholder insertion / replacement becomes a Yjs delta.
 */
export function pasteHandler(options: PasteHandlerOptions): Extension {
  const { pageId } = options;

  return EditorView.domEventHandlers({
    paste(event: ClipboardEvent, view: EditorView): boolean {
      const data = event.clipboardData;
      if (!data) return false;

      // --- File paste (image blob or any other clipboard file) ---
      const file = firstPastedFile(data);
      if (file) {
        event.preventDefault();
        if (!isUploadAllowedType(file)) {
          notify.warn(disallowedTypeMessage(file));
          return true;
        }
        // A pasted image is a nameless blob, so it gets the generated
        // `pasted-…` name; a file copied from the OS carries its own.
        const filename = isImageFile(file) ? generatePastedFilename(file.type) : file.name;
        const pos = view.state.selection.main.from;
        // Fire-and-forget: `runUpload` owns the placeholder lifecycle
        // and never throws (failures land in a static error marker).
        void runUpload(view, file, filename, pos, pageId);
        return true;
      }

      // --- Plain URL paste ---
      const text = data.getData('text/plain');
      const url = extractSingleUrl(text);
      if (url) {
        const { from, to } = view.state.selection.main;
        if (from !== to) {
          // Selection present → wrap it as a Markdown link.
          event.preventDefault();
          const selected = view.state.sliceDoc(from, to);
          const insert = `[${selected}](${url})`;
          view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
          return true;
        }
        // No selection: insert the URL plainly. Whether the cursor sits
        // inside `[…](…)` (insert plain → no double-wrap) or outside it
        // (insert plain → autolinks at render time per RFC-0002), the
        // outcome is the verbatim URL — so we let CodeMirror's default
        // paste insert it (preserving the browser's own undo grouping)
        // rather than re-dispatching. `isInsideLinkSyntax` is exported
        // for the unit tests that assert this documented distinction.
        return false;
      }

      // --- Anything else → CodeMirror default paste ---
      return false;
    },
  });
}
