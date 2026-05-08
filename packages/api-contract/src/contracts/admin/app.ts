import { initContract } from '@ts-rest/core';
import {
  AppSettingsValidationErrorSchema,
  GetAppSettingsResponseSchema,
  UpdateAppSettingsRequestSchema,
  UpdateAppSettingsResponseSchema,
} from '../../schemas/admin/app';
import { AdminRequiredErrorSchema, AuthenticationRequiredErrorSchema } from '../../schemas/common';

const c = initContract();

/**
 * Admin-only App settings endpoints. The matching legacy routes are:
 *   GET  /_api/admin/app                 -> readAppSettings
 *   POST /_api/admin/settings/app + aws  -> updateAppSettings
 *
 * Both legacy POST endpoints fed the same `configService.saveConfig('crowi', form)`
 * call, so the new API merges them into a single PUT endpoint that operates on
 * the union of `app:*` and `upload:aws:*` keys. See the planner doc for why we
 * picked PUT over keeping two endpoints.
 */
export const adminAppContract = c.router({
  getAppSettings: {
    method: 'GET',
    path: '/admin/app',
    responses: {
      200: GetAppSettingsResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
    },
    summary: 'Read the current App settings (incl. AWS upload section)',
  },
  updateAppSettings: {
    method: 'PUT',
    path: '/admin/app',
    body: UpdateAppSettingsRequestSchema,
    responses: {
      200: UpdateAppSettingsResponseSchema,
      400: AppSettingsValidationErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
    },
    summary: 'Update App settings — partial updates per section, secret masking on input',
  },
});
