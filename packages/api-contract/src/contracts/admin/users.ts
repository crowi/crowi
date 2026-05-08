import { initContract } from '@ts-rest/core';
import {
  ListAdminUsersRequestSchema,
  ListAdminUsersResponseSchema,
  SearchAdminUsersByEmailRequestSchema,
  SearchAdminUsersByEmailResponseSchema,
} from '../../schemas/admin/users';
import { AdminRequiredErrorSchema, AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../../schemas/common';

const c = initContract();

/**
 * Admin → Users contract.
 *
 * Two read-only endpoints replacing the legacy:
 *   GET /_api/admin/users           -> Admin.api.user.index
 *   GET /_api/admin/users.search    -> Admin.api.usersSearch
 *
 * Mutating actions on users (invite / edit / role / activate / suspend /
 * password reset / email change) are intentionally out of scope for this
 * task; they keep using the legacy endpoints until migrated separately.
 *
 * Authorization is provided by the surrounding admin router
 * (`jwtAdminRequired`) — both 401 and 403 are produced by middleware, not by
 * the handlers themselves.
 */
export const adminUsersContract = c.router({
  listUsers: {
    method: 'GET',
    path: '/admin/users',
    query: ListAdminUsersRequestSchema,
    responses: {
      200: ListAdminUsersResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'List users with optional search (q) and pagination (page, limit)',
  },

  searchUsersByEmail: {
    method: 'GET',
    path: '/admin/users/search',
    query: SearchAdminUsersByEmailRequestSchema,
    responses: {
      200: SearchAdminUsersByEmailResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Email substring search for autocomplete-style UIs (max 51 results)',
  },
});
