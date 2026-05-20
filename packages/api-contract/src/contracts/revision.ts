import { initContract } from '@ts-rest/core';
import { z } from '@hono/zod-openapi';
import {
  ListRevisionsRequestSchema,
  ListRevisionsResponseSchema,
  GetRevisionResponseSchema,
  GetRevisionsRequestSchema,
  GetRevisionsResponseSchema,
  RevisionInvalidRequestErrorSchema,
} from '../schemas/revision';
import { PageNotFoundErrorSchema, PageNotGrantedErrorSchema } from '../schemas/page';
import { AuthenticationRequiredErrorSchema } from '../schemas/common';

const c = initContract();

export const revisionContract = c.router({
  /**
   * List revisions of a page (meta only, newest first).
   * Body is omitted from the response to keep payloads small;
   * use getRevision / getRevisions for full content.
   */
  listRevisions: {
    method: 'GET',
    path: '/pages/:page_id/revisions',
    pathParams: z.object({ page_id: z.string() }),
    query: ListRevisionsRequestSchema,
    responses: {
      200: ListRevisionsResponseSchema,
      400: RevisionInvalidRequestErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      403: PageNotGrantedErrorSchema,
      404: PageNotFoundErrorSchema,
    },
    summary: 'List revisions of a page (meta only)',
  },

  /**
   * Fetch multiple revisions in one call (e.g. for diff viewer).
   * All revisions must share the same path; the caller must have grant
   * on that path.
   */
  getRevisions: {
    method: 'GET',
    path: '/pages/revisions',
    query: GetRevisionsRequestSchema,
    responses: {
      200: GetRevisionsResponseSchema,
      400: RevisionInvalidRequestErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      403: PageNotGrantedErrorSchema,
      404: PageNotFoundErrorSchema,
    },
    summary: 'Get multiple revisions by ids',
  },

  /**
   * Fetch a single revision (with body) by id.
   * Grant is verified via the revision's path.
   */
  getRevision: {
    method: 'GET',
    path: '/pages/revisions/:id',
    pathParams: z.object({ id: z.string() }),
    responses: {
      200: GetRevisionResponseSchema,
      400: RevisionInvalidRequestErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      403: PageNotGrantedErrorSchema,
      404: PageNotFoundErrorSchema,
    },
    summary: 'Get a single revision by id',
  },
});
