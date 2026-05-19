import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  AddAttachmentResponseSchema,
  AttachmentErrorSchema,
  AttachmentMetaSchema,
  AttachmentUsageResponseSchema,
  ListAttachmentsResponseSchema,
  RemoveAttachmentResponseSchema,
  UploadAttachmentErrorSchema,
  UploadAttachmentResponseSchema,
} from '../schemas/attachment';
import { AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../schemas/common';

const c = initContract();

/**
 * ts-rest contract for attachment list / add / delete.
 *
 * Note: GET-by-id (`/api/v2/attachments/:id`) and GET-by-key
 * (`/api/v2/attachments/by-key/:key`) deliver raw bytes via Readable
 * pipe. They are NOT part of this contract — wrapping a streaming
 * response in ts-rest forces a full Buffer roundtrip which would defeat
 * the streaming. Those routes are registered as plain Express handlers
 * inside the same router file (see `routes/ts-rest/attachment.ts`).
 */
export const attachmentContract = c.router({
  /**
   * List attachments for a page. Requires that the caller can view the
   * page (`loadGrantedPage` succeeds); otherwise 404 to avoid leaking
   * the page's existence.
   */
  listAttachments: {
    method: 'GET',
    path: '/pages/:pageId/attachments',
    pathParams: z.object({
      pageId: z.string(),
    }),
    responses: {
      200: ListAttachmentsResponseSchema,
      400: AttachmentErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      404: AttachmentErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'List attachments for a page',
  },

  /**
   * Add an attachment to an existing page. The legacy `/_api/attachments.add`
   * supported `page_id=0` + path to implicitly create the page; the new
   * endpoint requires the page to exist (responsibility-separation — the
   * client must call createPage first).
   */
  addAttachment: {
    method: 'POST',
    path: '/pages/:pageId/attachments',
    pathParams: z.object({
      pageId: z.string(),
    }),
    contentType: 'multipart/form-data',
    body: z.object({
      file: z.any().describe('Attachment binary'),
    }),
    responses: {
      200: AddAttachmentResponseSchema,
      400: AttachmentErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      404: AttachmentErrorSchema,
      500: AttachmentErrorSchema,
    },
    summary: 'Add an attachment to a page',
  },

  /**
   * Phase 8 — full attachment usage breakdown for a page. Scans every
   * revision body of the page to split attachments into `latest`
   * (referenced by the current revision) and `past` (referenced only by
   * older revisions, plus orphans). Backs the `/_attachments?pageId=`
   * page. Same view-grant requirement as `listAttachments`.
   */
  getAttachmentUsage: {
    method: 'GET',
    path: '/pages/:pageId/attachments/usage',
    pathParams: z.object({
      pageId: z.string(),
    }),
    responses: {
      200: AttachmentUsageResponseSchema,
      400: AttachmentErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      404: AttachmentErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Get the full attachment usage breakdown for a page',
  },

  /**
   * Metadata for a single attachment, keyed by its Mongo ObjectId. Backs the
   * in-body attachment modal: a `/api/v2/attachments/<id>` link / embed in a
   * page body carries only the id, so the modal fetches the file's metadata
   * (name, size, type, uploader, url) here instead of full-page-navigating
   * to the raw stream route.
   *
   * Authorization mirrors the streaming route `GET /api/v2/attachments/:id`:
   * the caller must be able to view the page that owns the attachment
   * (`loadGrantedPage` succeeds); 404 on any failure to avoid leaking the
   * existence of a hidden page / attachment.
   */
  getAttachmentMeta: {
    method: 'GET',
    path: '/attachments/:id/meta',
    pathParams: z.object({
      id: z.string(),
    }),
    responses: {
      200: AttachmentMetaSchema,
      400: AttachmentErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      404: AttachmentErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Get metadata for a single attachment by id',
  },

  /**
   * RFC-0004 Phase 6 — direct upload for the editor's paste / drag-and-drop
   * handlers. The client POSTs the file (multipart) with the owning
   * `pageId` (for the write-permission check) and an `intent` tag, then
   * splices the returned canonical `url` straight into the Markdown
   * source. Distinct from `addAttachment` in that it is rate-limited
   * (20 uploads/min/user → 429 + `Retry-After`), enforces the editor's
   * size / MIME caps, and returns the lean `{ url, filename, mimeType,
   * sizeBytes }` shape the editor needs rather than the full attachment
   * document. Browser-side upload progress is observed by the client via
   * `XMLHttpRequest.upload.onprogress`; the server just receives the
   * multipart body normally.
   */
  uploadAttachment: {
    method: 'POST',
    path: '/attachments/upload',
    contentType: 'multipart/form-data',
    // ts-rest validates `body` against the *raw* request before multer
    // has parsed the multipart payload, so the multipart fields (`file`,
    // `pageId`, `intent`) are not yet on `req.body`. Mirroring
    // `addAttachment`, the body schema stays permissive and the handler
    // validates the text fields itself after multer runs.
    body: z.object({
      file: z.any().describe('Attachment binary'),
    }),
    responses: {
      200: UploadAttachmentResponseSchema,
      400: UploadAttachmentErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      403: UploadAttachmentErrorSchema,
      413: UploadAttachmentErrorSchema,
      415: UploadAttachmentErrorSchema,
      429: UploadAttachmentErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Upload an attachment from the editor (paste / drag-and-drop)',
  },

  /**
   * Delete an attachment. Authorization is stricter than the legacy
   * `/_api/attachments.remove`: only the attachment creator, an admin,
   * or a user explicitly listed in `page.grantedUsers` can delete.
   */
  removeAttachment: {
    method: 'DELETE',
    path: '/attachments/:id',
    pathParams: z.object({
      id: z.string(),
    }),
    // ts-rest 3 runs body validation even on DELETE; Express's json middleware
    // supplies `{}` for an empty body, so `z.undefined()` would reject every
    // request. Relax to "any optional" — this endpoint never inspects body.
    body: z.unknown().optional(),
    responses: {
      200: RemoveAttachmentResponseSchema,
      400: AttachmentErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AttachmentErrorSchema,
      404: AttachmentErrorSchema,
      500: AttachmentErrorSchema,
    },
    summary: 'Remove an attachment',
  },
});
