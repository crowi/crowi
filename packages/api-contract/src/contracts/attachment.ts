/**
 * RFC-0006 Phase 4 Batch 6 — `attachment` resource ported to
 * `@hono/zod-openapi` route definitions. Six endpoints:
 *
 *   GET    /pages/{pageId}/attachments        — list (page-scoped)
 *   POST   /pages/{pageId}/attachments        — add (multipart)
 *   GET    /pages/{pageId}/attachments/usage  — usage breakdown
 *   GET    /attachments/{id}/meta             — single attachment meta
 *   POST   /attachments/upload                — editor paste / D&D upload (multipart)
 *   DELETE /attachments/{id}                  — remove
 *
 * Note: the raw streaming routes (`GET /attachments/{id}` /
 * `GET /attachments/by-key/{key}`) remain Express-mounted in the
 * bridge for now — they pipe Readable bytes and Hono's typed
 * response API does not express streaming-without-buffer cleanly.
 * Phase 6 cleanup converts them to native Hono `Response`-stream
 * handlers.
 *
 * Auth split:
 *   - `/pages/*` (list / add / usage) reuses the `revision` handler's
 *     broad `createJwtAuth(crowi)` apply — same shared-middleware
 *     pattern as page / page-preview / pageCollab / presence / draft.
 *     Header-only (Bearer), same as every other `createJwtAuth` consumer.
 *   - `/attachments/*` (meta / upload / remove) is OUTSIDE that prefix
 *     so the attachment handler installs `createAttachmentAuth(crowi)`
 *     (feature-auth-cookie-fallback-scope) on `/attachments/*` itself.
 *     `createAttachmentAuth` is its OWN boundary — `createJwtAuth` is
 *     header-only everywhere and never reads the `crowi.accessToken`
 *     cookie at all; only `createAttachmentAuth` does, and only for
 *     GET/HEAD on the three raw streaming delivery routes below
 *     (`/attachments/{id}`, `/attachments/{id}/original`,
 *     `/attachments/by-key/{key}`), which are hand-coded Hono routes
 *     outside this contract file (a browser `<img src>` / direct
 *     navigation to those cannot carry an Authorization header). Every
 *     endpoint IN this contract file (upload / meta / remove / add) is
 *     header-only — none of them accept the cookie, so this contract's
 *     `security: [{ bearerAuth: [] }]` on every route below is accurate
 *     as written.
 *
 * Multipart: `addAttachment` + `uploadAttachment` are implemented
 * Hono-native via `c.req.parseBody()`. multer is gone from this
 * resource (legacy `/_api/me/picture/upload` still uses it, so the
 * package dependency is removed in Phase 6 cleanup, not here).
 * `uploadAttachment` runs a `Content-Length` precheck BEFORE
 * `parseBody()` so a 50 MB+ body is 413'd without being buffered.
 */
import { createRoute, z } from '@hono/zod-openapi';
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

const PageIdPathParamsSchema = z.object({
  pageId: z.string().openapi({ description: 'Page id (24-char hex ObjectId)', example: '507f1f77bcf86cd799439011' }),
});

const AttachmentIdPathParamsSchema = z.object({
  id: z.string().openapi({ description: 'Attachment id (24-char hex ObjectId)', example: '507f1f77bcf86cd799439011' }),
});

/**
 * Multipart body schema for the `addAttachment` / `uploadAttachment`
 * endpoints. The file field is declared as `z.any()` because the actual
 * payload is a Web `File` (Hono `c.req.parseBody()` surfaces it) — we
 * only need to describe the field name + format for the OpenAPI spec
 * and let the handler narrow at runtime.
 */
const AddAttachmentBodySchema = z.object({
  file: z.any().openapi({ type: 'string', format: 'binary' }).optional(),
});

// `intent` is declared as `z.string().optional()` rather than
// `z.enum(['paste','dnd'])` because the handler returns the legacy
// `{ error: 'disallowed_type', ... }` envelope for a bad intent value,
// and a strict enum here would short-circuit that path via the
// `defaultHook` ValidationError envelope before the handler runs.
const UploadAttachmentBodySchema = z.object({
  file: z.any().openapi({ type: 'string', format: 'binary' }).optional(),
  pageId: z.string().optional(),
  intent: z
    .string()
    .optional()
    .openapi({ enum: ['paste', 'dnd'] }),
});

export const listAttachmentsRoute = createRoute({
  method: 'get',
  path: '/pages/{pageId}/attachments',
  tags: ['attachment'],
  security: [{ bearerAuth: [] }],
  summary: 'List attachments for a page',
  request: {
    params: PageIdPathParamsSchema,
  },
  responses: {
    200: {
      description: 'Attachment list (with `inUse` derived from the latest revision body)',
      content: { 'application/json': { schema: ListAttachmentsResponseSchema } },
    },
    400: {
      description: 'Invalid page id',
      content: { 'application/json': { schema: AttachmentErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Page not found or not granted',
      content: { 'application/json': { schema: AttachmentErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const addAttachmentRoute = createRoute({
  method: 'post',
  path: '/pages/{pageId}/attachments',
  tags: ['attachment'],
  security: [{ bearerAuth: [] }],
  summary: 'Add an attachment to a page (multipart/form-data)',
  request: {
    params: PageIdPathParamsSchema,
    body: {
      content: { 'multipart/form-data': { schema: AddAttachmentBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Attachment created',
      content: { 'application/json': { schema: AddAttachmentResponseSchema } },
    },
    400: {
      description: 'Missing file / invalid page id',
      content: { 'application/json': { schema: AttachmentErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Page not found or not granted',
      content: { 'application/json': { schema: AttachmentErrorSchema } },
    },
    413: {
      description: 'Request body exceeds the multipart envelope ceiling',
      content: { 'application/json': { schema: AttachmentErrorSchema } },
    },
    415: {
      description: 'MIME type not in the unified upload allow-list (feature-attachment-upload-policy)',
      content: { 'application/json': { schema: AttachmentErrorSchema } },
    },
    500: {
      description: 'Upload / storage failure',
      content: { 'application/json': { schema: AttachmentErrorSchema } },
    },
  },
});

export const getAttachmentUsageRoute = createRoute({
  method: 'get',
  path: '/pages/{pageId}/attachments/usage',
  tags: ['attachment'],
  security: [{ bearerAuth: [] }],
  summary: 'Get the full attachment usage breakdown for a page (latest vs past)',
  request: {
    params: PageIdPathParamsSchema,
  },
  responses: {
    200: {
      description: 'Usage breakdown (latest / past split, with referencing revisions)',
      content: { 'application/json': { schema: AttachmentUsageResponseSchema } },
    },
    400: {
      description: 'Invalid page id',
      content: { 'application/json': { schema: AttachmentErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Page not found or not granted',
      content: { 'application/json': { schema: AttachmentErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const getAttachmentMetaRoute = createRoute({
  method: 'get',
  path: '/attachments/{id}/meta',
  tags: ['attachment'],
  security: [{ bearerAuth: [] }],
  summary: 'Get metadata for a single attachment by id',
  request: {
    params: AttachmentIdPathParamsSchema,
  },
  responses: {
    200: {
      description: 'Attachment metadata (no `inUse` — that flag is page-scoped)',
      content: { 'application/json': { schema: AttachmentMetaSchema } },
    },
    400: {
      description: 'Invalid attachment id',
      content: { 'application/json': { schema: AttachmentErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Attachment not found / not granted',
      content: { 'application/json': { schema: AttachmentErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const uploadAttachmentRoute = createRoute({
  method: 'post',
  path: '/attachments/upload',
  tags: ['attachment'],
  security: [{ bearerAuth: [] }],
  summary: 'Upload an attachment from the editor (paste / drag-and-drop)',
  request: {
    body: {
      content: { 'multipart/form-data': { schema: UploadAttachmentBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Upload accepted; returns the lean { url, filename, mimeType, sizeBytes } shape the editor splices into the source',
      content: { 'application/json': { schema: UploadAttachmentResponseSchema } },
    },
    400: {
      description: 'Missing / malformed fields',
      content: { 'application/json': { schema: UploadAttachmentErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'No permission for the target page',
      content: { 'application/json': { schema: UploadAttachmentErrorSchema } },
    },
    413: {
      description: 'Body exceeds the per-intent size cap',
      content: { 'application/json': { schema: UploadAttachmentErrorSchema } },
    },
    415: {
      description: 'MIME type not in the unified upload allow-list (feature-attachment-upload-policy)',
      content: { 'application/json': { schema: UploadAttachmentErrorSchema } },
    },
    429: {
      description: 'Per-user rate limit exceeded',
      content: { 'application/json': { schema: UploadAttachmentErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const removeAttachmentRoute = createRoute({
  method: 'delete',
  path: '/attachments/{id}',
  tags: ['attachment'],
  security: [{ bearerAuth: [] }],
  summary: 'Remove an attachment',
  request: {
    params: AttachmentIdPathParamsSchema,
  },
  responses: {
    200: {
      description: 'Attachment removed',
      content: { 'application/json': { schema: RemoveAttachmentResponseSchema } },
    },
    400: {
      description: 'Invalid attachment id',
      content: { 'application/json': { schema: AttachmentErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Forbidden (kept for legacy parity; current policy only requires view-grant)',
      content: { 'application/json': { schema: AttachmentErrorSchema } },
    },
    404: {
      description: 'Attachment not found / page not granted',
      content: { 'application/json': { schema: AttachmentErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: AttachmentErrorSchema } },
    },
  },
});

export const attachmentRoutes = {
  // `/pages/{pageId}/attachments/usage` MUST register before
  // `/pages/{pageId}/attachments` so the literal `/usage` suffix wins;
  // Hono is method+path based but the no-op stub chain mirrored on the
  // client side benefits from the same ordering convention used by
  // revision / notification / page.
  getAttachmentUsageRoute,
  listAttachmentsRoute,
  addAttachmentRoute,
  uploadAttachmentRoute,
  getAttachmentMetaRoute,
  removeAttachmentRoute,
};
