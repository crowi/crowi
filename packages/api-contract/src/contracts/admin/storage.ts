/**
 * RFC-0006 Phase 4 Batch 9 — `admin.storage` sub-contract ported to
 * `@hono/zod-openapi` route definitions.
 *
 *   GET /admin/storage  — read-only: active storage driver + installed list
 *
 * Auth + install:
 *   - The handler installs `createJwtAdminRequired(crowi)` broadly on
 *     `/admin/storage/*` plus the bare `/admin/storage` path.
 */
import { createRoute } from '@hono/zod-openapi';

import { GetStorageStatusResponseSchema } from '../../schemas/admin/storage';
import { AdminRequiredErrorSchema, AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../../schemas/common';

export const getStorageStatusRoute = createRoute({
  method: 'get',
  path: '/admin/storage',
  tags: ['admin.storage'],
  security: [{ bearerAuth: [] }],
  summary: 'Get the active storage driver and the list of installed drivers',
  responses: {
    200: {
      description: 'Active driver pointer + every registered driver',
      content: { 'application/json': { schema: GetStorageStatusResponseSchema } },
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

export const adminStorageRoutes = {
  getStorageStatusRoute,
};

export type {
  ActiveStorageDriver,
  GetStorageStatusResponse,
  StorageDriverEntry,
} from '../../schemas/admin/storage';
