import { z } from 'zod';
import { UserPublicSchema } from './userPublic';

/**
 * Attachment as returned by the ts-rest endpoints.
 *
 * - `creator` is populated server-side via `Attachment.getListByPageId`
 *   (or after `Attachment.create()` on the add path) so consumers always
 *   see the public user shape and never bare ObjectId strings.
 * - `url` is a relative URL (`/api/v2/attachments/:id`) computed by the
 *   handler from the document's `fileUrl` virtual. Browsers fetch the
 *   stream endpoint via the same origin, so absolute URLs are not needed.
 * - `inUse` (Phase 7) is `true` when the attachment is referenced by the
 *   page's latest revision body (a `/api/v2/attachments/<id>` or legacy
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
  inUse: z.boolean(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

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
 * RFC-0004 Phase 6 — `POST /api/v2/attachments/upload`.
 *
 * The editor's paste / drag-and-drop handlers upload a file directly
 * (multipart) and immediately splice the returned `url` into the
 * Markdown source. Unlike `addAttachment`, this endpoint is keyed by
 * the editor `intent` (`paste` / `dnd`) for telemetry and applies a
 * per-user upload rate limit; it shares the same `FileUploader` storage
 * path. See `docs/rfcs/0004-editor-ux-enhancement.md`
 * §"Attachment upload endpoint".
 */
export const UploadAttachmentResponseSchema = z.object({
  url: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
});
export type UploadAttachmentResponse = z.infer<typeof UploadAttachmentResponseSchema>;

/**
 * Error envelope for `POST /api/v2/attachments/upload`. The `error`
 * codes are lowercase + RFC-specified (distinct from the uppercase
 * `AttachmentErrorCodeSchema` used by the list / add / delete endpoints)
 * because the editor maps each code to a specific user-facing toast:
 *   - `too_large`      — file exceeds the size cap (413).
 *   - `disallowed_type`— MIME type not in the allow-list (415).
 *   - `rate_limited`   — per-user upload budget exhausted (429); a
 *                        `Retry-After` header carries the cooldown.
 *   - `no_permission`  — caller cannot write attachments to `pageId` (403).
 * `details` is an open bag for code-specific context (e.g. the
 * offending MIME, the size limit) the client may surface verbatim.
 */
export const UploadAttachmentErrorCodeSchema = z.enum(['too_large', 'disallowed_type', 'rate_limited', 'no_permission']);
export type UploadAttachmentErrorCode = z.infer<typeof UploadAttachmentErrorCodeSchema>;

export const UploadAttachmentErrorSchema = z.object({
  error: UploadAttachmentErrorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type UploadAttachmentError = z.infer<typeof UploadAttachmentErrorSchema>;

/**
 * MIME allow-lists for `POST /api/v2/attachments/upload`, shared by the
 * api handler (authoritative enforcement) and the web editor's paste /
 * drag-and-drop handlers (early client-side rejection). Kept here so the
 * two sides cannot drift — see `docs/rfcs/0004-editor-ux-enhancement.md`
 * §"Image paste limits" / §"D&D limits".
 *
 * `paste` accepts images only (a clipboard blob is always an image);
 * `dnd` additionally accepts documents + archives.
 */
export const IMAGE_UPLOAD_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'] as const;
export const DND_EXTRA_UPLOAD_MIME = ['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/zip'] as const;
