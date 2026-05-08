import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  AdminUserIdParamSchema,
  AdminUserMutationResponseSchema,
  EditAdminUserRequestSchema,
  InviteUsersRequestSchema,
  InviteUsersResponseSchema,
  ListAdminUsersRequestSchema,
  ListAdminUsersResponseSchema,
  ResetPasswordResponseSchema,
  SearchAdminUsersByEmailRequestSchema,
  SearchAdminUsersByEmailResponseSchema,
  UpdateAdminUserEmailRequestSchema,
} from '../../schemas/admin/users';
import {
  AdminRequiredErrorSchema,
  AuthenticationRequiredErrorSchema,
  ConflictErrorSchema,
  InternalServerErrorSchema,
  NotFoundErrorSchema,
  ValidationErrorSchema,
} from '../../schemas/common';

const c = initContract();

/**
 * Admin → Users contract.
 *
 * Read-only endpoints replace the legacy:
 *   GET /_api/admin/users           -> Admin.api.user.index
 *   GET /_api/admin/users.search    -> Admin.api.usersSearch
 *
 * Mutating endpoints replace the legacy POST /_api/admin/user/* and
 * /_api/admin/users.* endpoints with RESTful paths under the same /admin/users
 * namespace:
 *
 *   POST   /admin/users/invite                  (User.createUsersByInvitation)
 *   PATCH  /admin/users/:id                     (name + email)
 *   PUT    /admin/users/:id/admin               (makeAdmin)
 *   DELETE /admin/users/:id/admin               (removeFromAdmin)
 *   PUT    /admin/users/:id/status/active       (statusActivate)
 *   PUT    /admin/users/:id/status/suspended    (statusSuspend)
 *   POST   /admin/users/:id/reset-password      (resetPasswordByRandomString)
 *   PUT    /admin/users/:id/email               (email-only update)
 *
 * Authorization is provided by the surrounding admin router
 * (`jwtAdminRequired`) — both 401 and 403 are produced by middleware, not by
 * the handlers themselves.
 *
 * The legacy `/_api/admin/user/*` routes are intentionally left in place for
 * backward compatibility; their removal is tracked as a separate clean-up
 * task.
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

  /**
   * POST /admin/users/invite
   * Bulk-invite by email. Existing emails are reported as `status: 'exists'`
   * rather than failing the whole batch.
   */
  inviteUsers: {
    method: 'POST',
    path: '/admin/users/invite',
    body: InviteUsersRequestSchema,
    responses: {
      200: InviteUsersResponseSchema,
      400: ValidationErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Invite a batch of users by email; returns per-email status',
  },

  /**
   * PATCH /admin/users/:id
   * Update both name and email. Email collisions with another user yield 409.
   */
  editUser: {
    method: 'PATCH',
    path: '/admin/users/:id',
    pathParams: AdminUserIdParamSchema,
    body: EditAdminUserRequestSchema,
    responses: {
      200: AdminUserMutationResponseSchema,
      400: ValidationErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      404: NotFoundErrorSchema,
      409: ConflictErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: "Update a user's name and email",
  },

  /**
   * PUT /admin/users/:id/admin — grant admin permission.
   */
  makeAdmin: {
    method: 'PUT',
    path: '/admin/users/:id/admin',
    pathParams: AdminUserIdParamSchema,
    // Empty body — Express body-parser hydrates req.body to {} for an empty
    // POST/PUT, which would fail z.undefined(). Use z.unknown() so the schema
    // accepts both shapes without complaining.
    body: z.unknown(),
    responses: {
      200: AdminUserMutationResponseSchema,
      400: ValidationErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      404: NotFoundErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Grant admin permission to a user',
  },

  /**
   * DELETE /admin/users/:id/admin — revoke admin permission.
   * No body; the path itself encodes the action.
   */
  removeFromAdmin: {
    method: 'DELETE',
    path: '/admin/users/:id/admin',
    pathParams: AdminUserIdParamSchema,
    body: z.unknown(),
    responses: {
      200: AdminUserMutationResponseSchema,
      400: ValidationErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      404: NotFoundErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Revoke admin permission from a user',
  },

  /**
   * PUT /admin/users/:id/status/active — set status to ACTIVE.
   * Emits the `userEvent` 'activated' side-effect (mirrors legacy).
   */
  activateUser: {
    method: 'PUT',
    path: '/admin/users/:id/status/active',
    pathParams: AdminUserIdParamSchema,
    body: z.unknown(),
    responses: {
      200: AdminUserMutationResponseSchema,
      400: ValidationErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      404: NotFoundErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Activate a user (status -> ACTIVE)',
  },

  /**
   * PUT /admin/users/:id/status/suspended — set status to SUSPENDED.
   */
  suspendUser: {
    method: 'PUT',
    path: '/admin/users/:id/status/suspended',
    pathParams: AdminUserIdParamSchema,
    body: z.unknown(),
    responses: {
      200: AdminUserMutationResponseSchema,
      400: ValidationErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      404: NotFoundErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Suspend a user (status -> SUSPENDED)',
  },

  /**
   * POST /admin/users/:id/reset-password
   * Returns the generated plaintext password (legacy parity).
   */
  resetPassword: {
    method: 'POST',
    path: '/admin/users/:id/reset-password',
    pathParams: AdminUserIdParamSchema,
    body: z.unknown(),
    responses: {
      200: ResetPasswordResponseSchema,
      400: ValidationErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      404: NotFoundErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: "Reset a user's password to a random value (returns plaintext)",
  },

  /**
   * PUT /admin/users/:id/email — email-only update.
   * Email collisions with another user yield 409.
   */
  updateUserEmail: {
    method: 'PUT',
    path: '/admin/users/:id/email',
    pathParams: AdminUserIdParamSchema,
    body: UpdateAdminUserEmailRequestSchema,
    responses: {
      200: AdminUserMutationResponseSchema,
      400: ValidationErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      404: NotFoundErrorSchema,
      409: ConflictErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: "Update a user's email address",
  },
});
