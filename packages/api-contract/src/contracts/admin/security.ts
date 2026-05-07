import { initContract } from '@ts-rest/core';
import { GetSecuritySettingsResponseSchema, UpdateSecuritySettingsRequestSchema, UpdateSecuritySettingsResponseSchema } from '../../schemas/admin/security';
import { AdminRequiredErrorSchema, AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../../schemas/common';

const c = initContract();

/**
 * Admin → Security settings contract.
 *
 * Exposes the four `security:*` keys (basicName / basicSecret /
 * registrationMode / registrationWhiteList) under RESTful paths. Requires JWT
 * + admin permission; both 401 and 403 are produced by the surrounding
 * `jwtAdminRequired` middleware, not by handlers themselves.
 */
export const adminSecurityContract = c.router({
  getSecuritySettings: {
    method: 'GET',
    path: '/admin/security',
    responses: {
      200: GetSecuritySettingsResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Get the current security:* settings',
  },

  updateSecuritySettings: {
    method: 'PUT',
    path: '/admin/security',
    body: UpdateSecuritySettingsRequestSchema,
    responses: {
      200: UpdateSecuritySettingsResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Update security:* settings (basicName / basicSecret / registrationMode / registrationWhiteList)',
  },
});
