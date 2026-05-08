import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { AddAttachmentResponseSchema, AttachmentErrorSchema, ListAttachmentsResponseSchema, RemoveAttachmentResponseSchema } from '../schemas/attachment';
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
