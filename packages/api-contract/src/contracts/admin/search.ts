import { initContract } from '@ts-rest/core';
import { GetSearchStatusResponseSchema } from '../../schemas/admin/search';
import { AdminRequiredErrorSchema, AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../../schemas/common';

const c = initContract();

/**
 * Admin → Search status contract.
 *
 * Read-only surface for the `/admin/search` page. Reports which search
 * driver is currently active (per `crowi.config.json:search.driver`) and
 * lists every driver any loaded plugin has registered. Switching drivers
 * is operator-side (`crowi.config.json` + restart) and full-index rebuild
 * runs through the `crowi-admin search rebuild` CLI subcommand. Both
 * intentionally bypass HTTP — long rebuilds shouldn't tie up an admin
 * request, and rebuild semantics are plugin-defined (the CLI just
 * delegates to `driver.rebuild()`).
 *
 * Authorization (JWT + admin permission) is enforced by the surrounding
 * `jwtAdminRequired` middleware on the admin router.
 */
export const adminSearchContract = c.router({
  getSearchStatus: {
    method: 'GET',
    path: '/admin/search',
    responses: {
      200: GetSearchStatusResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Get the active search driver and the list of installed drivers',
  },
});
