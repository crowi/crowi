import { UPLOAD_ALLOWED_MIME } from '@crowi/api-contract';

/**
 * feature-attachment-upload-policy — the two INDEPENDENT questions the
 * editor asks about a file it is about to upload, kept in one module so
 * paste (`paste-handler.ts`) and drag-and-drop (`drop-handler.ts`) can
 * never answer them differently (answering them differently per
 * affordance is the exact bug this feature exists to fix):
 *
 *   1. **May it be uploaded at all?** — {@link isUploadAllowedType} /
 *      {@link disallowedTypeMessage}. The same allow-list the server
 *      applies to every route (attach button / paste / D&D alike),
 *      sourced from `@crowi/api-contract` so this early client-side
 *      rejection cannot drift from the server's authoritative check.
 *   2. **Is it embedded as an image or as a link?** —
 *      {@link isImageFile}. A pure "is this an image type" question that
 *      deliberately does NOT consult the allow-list: widening what may
 *      be uploaded must never change what gets embedded as `![](url)`.
 */

/**
 * MIME types accepted by every upload route. Keyed by MIME type — the
 * browser populates `File.type` from the OS, falling back to `''` for
 * unknown types; {@link isUploadAllowedType} normalizes that empty case
 * exactly like the server does before checking membership.
 */
export const UPLOAD_MIME_SET = new Set<string>(UPLOAD_ALLOWED_MIME);

/** True when `file` is an image (→ `![](url)` insertion, not `[](url)`). */
export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

/**
 * True when `file`'s declared MIME type is allowed — normalizing an empty
 * `File.type` to `'application/octet-stream'` FIRST, exactly like the
 * server does (`attachment.ts`'s `declaredType = file.type || 'application/
 * octet-stream'`). Several OSes report an empty/generic `File.type` for a
 * variety of files (`.md`/`.csv`, but also e.g. `.docx` on some platforms)
 * — since `'application/octet-stream'` is itself a member of
 * {@link UPLOAD_MIME_SET}, this reduces to "an empty type is always
 * accepted here, same as it always would be by the server". Deriving the
 * fallback from a separate, narrower allow-list of "known text-ish
 * extensions" (the previous approach) let this early client-side reject
 * diverge from the server's actual verdict — e.g. a `.docx` with an empty
 * `File.type` passed the attach button (server normalizes + accepts) but
 * was rejected here, reproducing the exact button-vs-D&D inconsistency
 * this feature exists to fix.
 */
export function isUploadAllowedType(file: File): boolean {
  const declaredType = file.type || 'application/octet-stream';
  return UPLOAD_MIME_SET.has(declaredType);
}

/** Lower-cased file extension (without the dot), or `''` when none. */
function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Human label for a rejected file's type, for the disallowed-type toast. */
function typeLabel(file: File): string {
  if (file.type) return file.type;
  const ext = fileExtension(file.name);
  return ext ? `.${ext}` : 'unknown';
}

/**
 * The disallowed-type toast text. Deliberately the same phrasing the
 * server returns in its 415 body (`attachment.ts`'s
 * `disallowedMimeMessage`), so a rejection reads identically whether it
 * was caught client-side or server-side.
 */
export function disallowedTypeMessage(file: File): string {
  return `Files of type ${typeLabel(file)} cannot be uploaded.`;
}
