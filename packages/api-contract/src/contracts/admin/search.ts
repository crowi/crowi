/**
 * RFC-0006 Phase 4 Batch 9 — `admin.search` sub-contract ported to
 * `@hono/zod-openapi` route definitions.
 *
 *   GET /admin/search  — read-only: active search driver + installed list
 *
 * Auth + install:
 *   - The handler installs `createJwtAdminRequired(crowi)` broadly on
 *     `/admin/search/*` plus the bare `/admin/search` path.
 *
 * Note: This is the admin status endpoint. The user-facing `/search`
 * endpoint (Batch 7) is unrelated — it sits under `/search` (no `/admin`
 * prefix) and is handled by `hono/handlers/search.ts`.
 */
import { createRoute } from '@hono/zod-openapi';

import { GetSearchStatusResponseSchema } from '../../schemas/admin/search';
import { AdminRequiredErrorSchema, AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../../schemas/common';

export const getSearchStatusRoute = createRoute({
  method: 'get',
  path: '/admin/search',
  tags: ['admin.search'],
  security: [{ bearerAuth: [] }],
  summary: 'Get the active search driver and the list of installed drivers',
  responses: {
    200: {
      description: 'Active driver pointer + every registered driver',
      content: { 'application/json': { schema: GetSearchStatusResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Admin permission required',
      content: { 'application/json': { schema: AdminRequiredErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const adminSearchRoutes = {
  getSearchStatusRoute,
};

export type {
  ActiveSearchDriver,
  GetSearchStatusResponse,
  SearchDriverEntry,
} from '../../schemas/admin/search';
