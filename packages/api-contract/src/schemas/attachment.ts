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
});
export type Attachment = z.infer<typeof AttachmentSchema>;

// GET /pages/:pageId/attachments
export const ListAttachmentsResponseSchema = z.object({
  attachments: z.array(AttachmentSchema),
});
export type ListAttachmentsResponse = z.infer<typeof ListAttachmentsResponseSchema>;

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
