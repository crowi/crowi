import { initContract } from '@ts-rest/core';
import { GetStorageStatusResponseSchema } from '../../schemas/admin/storage';
import { AdminRequiredErrorSchema, AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../../schemas/common';

const c = initContract();

/**
 * Admin → Storage status contract.
 *
 * Read-only surface for the `/admin/storage` page. Reports which storage
 * driver is currently active (per `crowi.config.json:storage.driver`) and
 * lists every driver any loaded plugin has registered. The page itself is
 * a status / discovery view; switching drivers is operator-side
 * (`crowi.config.json` + restart) and file migration runs through the
 * `crowi-admin storage copy` CLI subcommand. Both intentionally bypass HTTP
 * — see `.feature-state/specs/feature-admin-storage.md`.
 *
 * Authorization (JWT + admin permission) is enforced by the surrounding
 * `jwtAdminRequired` middleware on the admin router.
 */
export const adminStorageContract = c.router({
  getStorageStatus: {
    method: 'GET',
    path: '/admin/storage',
    responses: {
      200: GetStorageStatusResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Get the active storage driver and the list of installed drivers',
  },
});
