import { z } from '@hono/zod-openapi';
import { UserPublicSchema } from './user-public';

/**
 * Attachment as returned by the ts-rest endpoints.
 *
 * - `creator` is populated server-side via `Attachment.getListByPageId`
 *   (or after `Attachment.create()` on the add path) so consumers always
 *   see the public user shape and never bare ObjectId strings.
 * - `url` is a relative URL (`/api/attachments/:id`) computed by the
 *   handler from the document's `fileUrl` virtual. Browsers fetch the
 *   stream endpoint via the same origin, so absolute URLs are not needed.
 *   feature-image-derivative-optimization Phase 2 — this URL now serves the
 *   display derivative when one is available (falling back to original),
 *   NOT always the original bytes.
 * - `originalUrl` (feature-image-derivative-optimization Phase 2) is
 *   `${url}/original` — always resolves to the original bytes regardless of
 *   `derivatives.display`. Derived, not stored (same as `url`).
 * - `inUse` (Phase 7) is `true` when the attachment is referenced by the
 *   page's latest revision body (a `/api/attachments/<id>` or legacy
 *   `/files/<id>` URI). `listAttachments` computes it by scanning the
 *   latest revision body once; when the revision is missing or empty it
 *   falls back to `true` for every attachment so files are not hidden
 *   while the reference state is undetermined. The `addAttachment`
 *   (upload) response sets `inUse: false` — a freshly uploaded file is
 *   not yet spliced into the body.
 */
export const AttachmentSchema = z.object({
  _id: z.string(),
  page: z.string(),
  creator: UserPublicSchema,
  filePath: z.string(),
  fileName: z.string(),
  originalName: z.string(),
  fileFormat: z.string(),
  fileSize: z.number(),
  createdAt: z.string(),
  url: z.string(),
  originalUrl: z.string(),
  inUse: z.boolean(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/**
 * Attachment metadata as returned by `GET /api/attachments/:id/meta`.
 *
 * Identical to `AttachmentSchema` minus `inUse`: the meta endpoint resolves
 * a bare attachment id (a body reference carries no page context) and
 * `inUse` is a page-scoped derivation computed by scanning a page's latest
 * revision body. `listAttachments` / `getAttachmentUsage` are the right
 * place for that flag; surfacing a meaningless value here would be a lie,
 * so the field is omitted instead.
 */
export const AttachmentMetaSchema = AttachmentSchema.omit({ inUse: true });
export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;

// GET /pages/:pageId/attachments
export const ListAttachmentsResponseSchema = z.object({
  attachments: z.array(AttachmentSchema),
});
export type ListAttachmentsResponse = z.infer<typeof ListAttachmentsResponseSchema>;

/**
 * Phase 8 — one past-revision usage entry for an attachment that is NOT
 * referenced by the page's latest revision. `referencingRevisions` lists
 * every past revision whose body embeds the attachment (newest-first);
 * each entry links to the revision view (`/<path>?revision_id=<id>`).
 * An empty `referencingRevisions` array means the attachment is an
 * orphan — referenced by no revision at all.
 */
export const PastAttachmentUsageSchema = z.object({
  attachment: AttachmentSchema,
  referencingRevisions: z.array(
    z.object({
      revisionId: z.string(),
      createdAt: z.string(),
      author: UserPublicSchema,
    }),
  ),
});
export type PastAttachmentUsage = z.infer<typeof PastAttachmentUsageSchema>;

/**
 * Phase 8 — `GET /pages/:pageId/attachments/usage`.
 *
 * Splits every attachment on a page into two groups by scanning all of
 * the page's revision bodies for embed URIs:
 *   - `latest`: attachments referenced by the page's current (latest)
 *     revision body.
 *   - `past`: attachments referenced only by past revisions (plus
 *     orphans referenced by none), each carrying the revisions that
 *     used it so the `/_attachments` page can link back to them.
 *
 * `pagePath` is included so the web client can build the
 * `/<pagePath>?revision_id=<id>` revision links without a second
 * page lookup.
 */
export const AttachmentUsageResponseSchema = z.object({
  pagePath: z.string(),
  latest: z.array(AttachmentSchema),
  past: z.array(PastAttachmentUsageSchema),
});
export type AttachmentUsageResponse = z.infer<typeof AttachmentUsageResponseSchema>;

// POST /pages/:pageId/attachments (multipart) → response
export const AddAttachmentResponseSchema = z.object({
  attachment: AttachmentSchema,
  url: z.string(),
});
export type AddAttachmentResponse = z.infer<typeof AddAttachmentResponseSchema>;

// DELETE /attachments/:id
export const RemoveAttachmentResponseSchema = z.object({
  success: z.literal(true),
});
export type RemoveAttachmentResponse = z.infer<typeof RemoveAttachmentResponseSchema>;

/**
 * Typed error envelope for the attachment endpoints. We do not lift these
 * codes to `common.ts` because they are scoped to a single contract and
 * each carries semantics the standard `ApiErrorSchema` does not capture
 * (e.g. `FORBIDDEN_FOR_DELETE`).
 */
export const AttachmentErrorCodeSchema = z.enum([
  'INVALID_PAGE_ID',
  'PAGE_NOT_FOUND',
  'FILE_MISSING',
  'FILE_TOO_LARGE',
  'DISALLOWED_MIME',
  'INVALID_ATTACHMENT_ID',
  'ATTACHMENT_NOT_FOUND',
  'FORBIDDEN_FOR_DELETE',
  'UPLOAD_FAILED',
  'REMOVE_FAILED',
]);

export const AttachmentErrorSchema = z.object({
  error: z.object({
    code: AttachmentErrorCodeSchema,
    message: z.string(),
  }),
});
export type AttachmentError = z.infer<typeof AttachmentErrorSchema>;

/**
 * RFC-0004 Phase 6 — `POST /api/attachments/upload`.
 *
 * The editor's paste / drag-and-drop handlers upload a file directly
 * (multipart) and immediately splice the returned `url` into the
 * Markdown source. Unlike `addAttachment`, this endpoint applies a
 * per-user upload rate limit; it shares the same `FileUploader` storage
 * path. See `docs/rfcs/0004-editor-ux-enhancement.md`
 * §"Attachment upload endpoint". The request body carries no `intent`
 * (`paste` / `dnd`) field: the size cap is a single value, independent of
 * which affordance triggered the upload.
 */
export const UploadAttachmentResponseSchema = z.object({
  url: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
});
export type UploadAttachmentResponse = z.infer<typeof UploadAttachmentResponseSchema>;

/**
 * Error envelope for `POST /api/attachments/upload`. The `error`
 * codes are lowercase + RFC-specified (distinct from the uppercase
 * `AttachmentErrorCodeSchema` used by the list / add / delete endpoints)
 * because the editor maps each code to a specific user-facing toast:
 *   - `too_large`      — file exceeds the size cap (413).
 *   - `disallowed_type`— malformed request (bad multipart body, missing
 *                        file); a generic 400 bucket kept as-is for those
 *                        unrelated failure modes.
 *   - `DISALLOWED_MIME`— the file's MIME type is outside the unified
 *                        upload allow-list (415). Deliberately spelled
 *                        the SAME as `AttachmentErrorCodeSchema`'s
 *                        `DISALLOWED_MIME` (not lowercased to
 *                        `disallowed_mime`) — feature-attachment-upload-policy's
 *                        cross-route parity requirement is that a MIME-type
 *                        rejection carries an identical code AND message
 *                        everywhere it happens (`addAttachment` and
 *                        `uploadAttachment` alike), even though the two
 *                        endpoints' envelopes otherwise keep their own
 *                        established casing convention for unrelated codes.
 *   - `rate_limited`   — per-user upload budget exhausted (429); a
 *                        `Retry-After` header carries the cooldown.
 *   - `no_permission`  — caller cannot write attachments to `pageId` (403).
 * `details` is an open bag for code-specific context (e.g. the
 * offending MIME, the size limit) the client may surface verbatim.
 */
export const UploadAttachmentErrorCodeSchema = z.enum(['too_large', 'disallowed_type', 'DISALLOWED_MIME', 'rate_limited', 'no_permission']);
export type UploadAttachmentErrorCode = z.infer<typeof UploadAttachmentErrorCodeSchema>;

export const UploadAttachmentErrorSchema = z.object({
  error: UploadAttachmentErrorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type UploadAttachmentError = z.infer<typeof UploadAttachmentErrorSchema>;

/**
 * The single "may this be uploaded at all" allow-list, shared by every
 * upload path: the general page attachment endpoint
 * (`POST /pages/:pageId/attachments`) and the editor's paste / drag-and-drop
 * endpoint (`POST /attachments/upload`). A file's fate does not depend on
 * which of the three affordances (attach button / paste / drag-and-drop)
 * triggered the upload. The SIZE cap (the api handler's single upload size
 * limit) is unified the same way: it applies regardless of route or
 * client-declared intent.
 *
 * Deliberately independent of `INLINE_SAFE_MIME`
 * (`attachment-stream.ts`) — that is a strict security boundary deciding
 * what may render inline in the browser, updated rarely and separately.
 * This list decides what may be STORED at all, and can be broad because
 * everything not on `INLINE_SAFE_MIME` is delivered as a download
 * regardless of whether it is accepted here.
 *
 * Covers: raster + vector images, common document / text formats, office
 * documents (docx/xlsx/pptx and their legacy doc/xls/ppt forms), archives,
 * and the audio/video/json/xml/html types `@crowi/cli`'s `attach add` can
 * declare (`packages/cli/src/lib/media-type.ts`) — the general attach
 * route had NO check before this feature, so anything CLI could already
 * send must keep working. `application/octet-stream` (a client that sends
 * no `Content-Type`, or an unrecognised extension) is intentionally
 * included: an unknown type is not "clearly undesirable", it is simply
 * unknown, and it already downloads instead of rendering inline.
 */
export const UPLOAD_ALLOWED_MIME = [
  // Raster + vector images.
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/avif',
  'image/apng',
  'image/x-icon',
  // Documents / text.
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/xml',
  'text/html',
  // Office documents.
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Archives.
  'application/zip',
  'application/gzip',
  'application/x-tar',
  // Audio / video.
  'audio/mpeg',
  'audio/wav',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  // Unknown / unset — see the note above.
  'application/octet-stream',
] as const;

/**
 * Response for `GET /attachments/upload-policy`.
 *
 * Publishes the server's actual upload policy so a client (CLI / curl / MCP)
 * can stop guessing what this instance allows. Every field is derived from
 * existing api constants, never a value maintained separately for this
 * response — see the handler's doc comment for the source of each field.
 *
 * - `allowedMimeTypes`: the same allow-list every upload route already
 *   enforces (`UPLOAD_ALLOWED_MIME` above).
 * - `extensionHints`: extension → MIME, for a client that only knows a
 *   filename and needs to declare a `Content-Type` for it.
 * - `maxBytes.attachment`: the SINGLE size limit every attachment upload
 *   route enforces (attach button / editor paste / editor drag-and-drop
 *   alike), resolved server-side from `CROWI_UPLOAD_MAX_BYTES` (default
 *   50 MB, hard ceiling 50 MB — the value is a memory budget, not a policy
 *   knob, because the api buffers the whole upload in memory; an operator
 *   may only lower it). No separate `paste` / `dnd` figure: a client-
 *   declared intent is not a real defence, so it cannot justify a
 *   different number.
 * - `profilePicture`: the separate, narrower policy `POST /me/picture`
 *   enforces (a finite image-type allow-list and its own size cap — not the
 *   general attachment policy above, and unaffected by it).
 */
export const UploadPolicyResponseSchema = z.object({
  allowedMimeTypes: z.array(z.string()),
  extensionHints: z.record(z.string(), z.string()),
  maxBytes: z.object({
    attachment: z.number(),
  }),
  profilePicture: z.object({
    allowedMimeTypes: z.array(z.string()),
    maxBytes: z.number(),
  }),
});
export type UploadPolicyResponse = z.infer<typeof UploadPolicyResponseSchema>;
