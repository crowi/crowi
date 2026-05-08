import { initContract } from '@ts-rest/core';
import {
  AuthSettingsValidationErrorSchema,
  GetAuthSettingsResponseSchema,
  UpdateAuthSettingsRequestSchema,
  UpdateAuthSettingsResponseSchema,
} from '../../schemas/admin/auth';
import { AdminRequiredErrorSchema, AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../../schemas/common';

const c = initContract();

/**
 * Admin → Authentication settings contract.
 *
 * Exposes the two `auth:*` keys (requireThirdPartyAuth / disablePasswordAuth)
 * under RESTful paths. Requires JWT + admin permission; both 401 and 403 are
 * produced by the surrounding `jwtAdminRequired` middleware, not by handlers
 * themselves.
 *
 * The 422 response covers the legacy self-lockout guard: if the requesting
 * admin tries to enable `disablePasswordAuth` without a connected third-party
 * identity (Google / GitHub), the request is rejected to prevent them from
 * losing the only path back into the system.
 */
export const adminAuthContract = c.router({
  getAuthSettings: {
    method: 'GET',
    path: '/admin/auth',
    responses: {
      200: GetAuthSettingsResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Get the current auth:* settings',
  },

  updateAuthSettings: {
    method: 'PUT',
    path: '/admin/auth',
    body: UpdateAuthSettingsRequestSchema,
    responses: {
      200: UpdateAuthSettingsResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      422: AuthSettingsValidationErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Update auth:* settings (requireThirdPartyAuth / disablePasswordAuth)',
  },
});
