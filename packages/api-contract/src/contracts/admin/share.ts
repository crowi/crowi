import { initContract } from '@ts-rest/core';
import { GetShareSettingsResponseSchema, UpdateShareSettingsRequestSchema, UpdateShareSettingsResponseSchema } from '../../schemas/admin/share';
import { AdminRequiredErrorSchema, AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../../schemas/common';

const c = initContract();

/**
 * Admin → Share settings contract.
 *
 * Exposes the single `app:externalShare` config key as a structured RESTful
 * resource. Authorization (JWT + admin permission) is enforced by the
 * surrounding `jwtAdminRequired` middleware on the admin router; both 401
 * and 403 are produced by that middleware, not by handlers themselves.
 *
 * Note: Share UUID CRUD (create/list/delete, secretKeyword, accesses.list)
 * is not part of this contract — it lives under `apiClient.share.*` (or
 * the as-yet-unmigrated `/_api/shares.*` legacy endpoints) and has a very
 * different lifecycle.
 */
export const adminShareContract = c.router({
  getShareSettings: {
    method: 'GET',
    path: '/admin/share',
    responses: {
      200: GetShareSettingsResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Get the current share settings (externalShare toggle)',
  },

  updateShareSettings: {
    method: 'PUT',
    path: '/admin/share',
    body: UpdateShareSettingsRequestSchema,
    responses: {
      200: UpdateShareSettingsResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Toggle external sharing on/off (persists `app:externalShare`)',
  },
});
