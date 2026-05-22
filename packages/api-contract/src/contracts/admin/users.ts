/**
 * RFC-0006 Phase 4 Batch 9 — `admin.users` sub-contract ported to
 * `@hono/zod-openapi` route definitions.
 *
 * 10 endpoints:
 *   GET    /admin/users                            (listUsers)
 *   GET    /admin/users/search                     (searchUsersByEmail)
 *   POST   /admin/users/invite                     (inviteUsers)
 *   PATCH  /admin/users/{id}                       (editUser)
 *   PUT    /admin/users/{id}/admin                 (makeAdmin)
 *   DELETE /admin/users/{id}/admin                 (removeFromAdmin)
 *   PUT    /admin/users/{id}/status/active         (activateUser)
 *   PUT    /admin/users/{id}/status/suspended      (suspendUser)
 *   POST   /admin/users/{id}/reset-password        (resetPassword)
 *   PUT    /admin/users/{id}/email                 (updateUserEmail)
 *
 * Auth + install:
 *   - The handler installs `createJwtAdminRequired(crowi)` broadly on
 *     `/admin/users/*` plus the bare `/admin/users` path.
 */
import { createRoute, z } from '@hono/zod-openapi';

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

export const listUsersRoute = createRoute({
  method: 'get',
  path: '/admin/users',
  tags: ['admin.users'],
  security: [{ bearerAuth: [] }],
  summary: 'List users with optional search (q) and pagination (page, limit)',
  request: {
    query: ListAdminUsersRequestSchema,
  },
  responses: {
    200: {
      description: 'Paginated user list',
      content: { 'application/json': { schema: ListAdminUsersResponseSchema } },
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

export const searchUsersByEmailRoute = createRoute({
  method: 'get',
  path: '/admin/users/search',
  tags: ['admin.users'],
  security: [{ bearerAuth: [] }],
  summary: 'Email substring search for autocomplete-style UIs (max 51 results)',
  request: {
    query: SearchAdminUsersByEmailRequestSchema,
  },
  responses: {
    200: {
      description: 'Matching users (capped at 51)',
      content: { 'application/json': { schema: SearchAdminUsersByEmailResponseSchema } },
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

export const inviteUsersRoute = createRoute({
  method: 'post',
  path: '/admin/users/invite',
  tags: ['admin.users'],
  security: [{ bearerAuth: [] }],
  summary: 'Invite a batch of users by email; returns per-email status',
  request: {
    body: {
      content: { 'application/json': { schema: InviteUsersRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Per-email status (created / exists / failed)',
      content: { 'application/json': { schema: InviteUsersResponseSchema } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ValidationErrorSchema } },
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

export const editUserRoute = createRoute({
  method: 'patch',
  path: '/admin/users/{id}',
  tags: ['admin.users'],
  security: [{ bearerAuth: [] }],
  summary: "Update a user's name and email",
  request: {
    params: AdminUserIdParamSchema,
    body: {
      content: { 'application/json': { schema: EditAdminUserRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated user',
      content: { 'application/json': { schema: AdminUserMutationResponseSchema } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ValidationErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Admin permission required',
      content: { 'application/json': { schema: AdminRequiredErrorSchema } },
    },
    404: {
      description: 'User not found',
      content: { 'application/json': { schema: NotFoundErrorSchema } },
    },
    409: {
      description: 'Email already in use by another user',
      content: { 'application/json': { schema: ConflictErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const makeAdminRoute = createRoute({
  method: 'put',
  path: '/admin/users/{id}/admin',
  tags: ['admin.users'],
  security: [{ bearerAuth: [] }],
  summary: 'Grant admin permission to a user',
  request: {
    params: AdminUserIdParamSchema,
  },
  responses: {
    200: {
      description: 'Updated user',
      content: { 'application/json': { schema: AdminUserMutationResponseSchema } },
    },
    400: {
      description: 'Invalid id',
      content: { 'application/json': { schema: ValidationErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Admin permission required',
      content: { 'application/json': { schema: AdminRequiredErrorSchema } },
    },
    404: {
      description: 'User not found',
      content: { 'application/json': { schema: NotFoundErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const removeFromAdminRoute = createRoute({
  method: 'delete',
  path: '/admin/users/{id}/admin',
  tags: ['admin.users'],
  security: [{ bearerAuth: [] }],
  summary: 'Revoke admin permission from a user',
  request: {
    params: AdminUserIdParamSchema,
  },
  responses: {
    200: {
      description: 'Updated user',
      content: { 'application/json': { schema: AdminUserMutationResponseSchema } },
    },
    400: {
      description: 'Invalid id',
      content: { 'application/json': { schema: ValidationErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Admin permission required',
      content: { 'application/json': { schema: AdminRequiredErrorSchema } },
    },
    404: {
      description: 'User not found',
      content: { 'application/json': { schema: NotFoundErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const activateUserRoute = createRoute({
  method: 'put',
  path: '/admin/users/{id}/status/active',
  tags: ['admin.users'],
  security: [{ bearerAuth: [] }],
  summary: 'Activate a user (status -> ACTIVE)',
  request: {
    params: AdminUserIdParamSchema,
  },
  responses: {
    200: {
      description: 'Updated user',
      content: { 'application/json': { schema: AdminUserMutationResponseSchema } },
    },
    400: {
      description: 'Invalid id',
      content: { 'application/json': { schema: ValidationErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Admin permission required',
      content: { 'application/json': { schema: AdminRequiredErrorSchema } },
    },
    404: {
      description: 'User not found',
      content: { 'application/json': { schema: NotFoundErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const suspendUserRoute = createRoute({
  method: 'put',
  path: '/admin/users/{id}/status/suspended',
  tags: ['admin.users'],
  security: [{ bearerAuth: [] }],
  summary: 'Suspend a user (status -> SUSPENDED)',
  request: {
    params: AdminUserIdParamSchema,
  },
  responses: {
    200: {
      description: 'Updated user',
      content: { 'application/json': { schema: AdminUserMutationResponseSchema } },
    },
    400: {
      description: 'Invalid id',
      content: { 'application/json': { schema: ValidationErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Admin permission required',
      content: { 'application/json': { schema: AdminRequiredErrorSchema } },
    },
    404: {
      description: 'User not found',
      content: { 'application/json': { schema: NotFoundErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const resetPasswordRoute = createRoute({
  method: 'post',
  path: '/admin/users/{id}/reset-password',
  tags: ['admin.users'],
  security: [{ bearerAuth: [] }],
  summary: "Reset a user's password to a random value (returns plaintext)",
  request: {
    params: AdminUserIdParamSchema,
  },
  responses: {
    200: {
      description: 'Updated user + new plaintext password',
      content: { 'application/json': { schema: ResetPasswordResponseSchema } },
    },
    400: {
      description: 'Invalid id',
      content: { 'application/json': { schema: ValidationErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Admin permission required',
      content: { 'application/json': { schema: AdminRequiredErrorSchema } },
    },
    404: {
      description: 'User not found',
      content: { 'application/json': { schema: NotFoundErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const updateUserEmailRoute = createRoute({
  method: 'put',
  path: '/admin/users/{id}/email',
  tags: ['admin.users'],
  security: [{ bearerAuth: [] }],
  summary: "Update a user's email address",
  request: {
    params: AdminUserIdParamSchema,
    body: {
      content: { 'application/json': { schema: UpdateAdminUserEmailRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated user',
      content: { 'application/json': { schema: AdminUserMutationResponseSchema } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ValidationErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Admin permission required',
      content: { 'application/json': { schema: AdminRequiredErrorSchema } },
    },
    404: {
      description: 'User not found',
      content: { 'application/json': { schema: NotFoundErrorSchema } },
    },
    409: {
      description: 'Email already in use by another user',
      content: { 'application/json': { schema: ConflictErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const adminUsersRoutes = {
  listUsersRoute,
  searchUsersByEmailRoute,
  inviteUsersRoute,
  editUserRoute,
  makeAdminRoute,
  removeFromAdminRoute,
  activateUserRoute,
  suspendUserRoute,
  resetPasswordRoute,
  updateUserEmailRoute,
};

export type {
  AdminPager,
  AdminUserIdParam,
  AdminUserMutationResponse,
  EditAdminUserRequest,
  InvitedUserResult,
  InviteUsersRequest,
  InviteUsersResponse,
  ListAdminUsersRequest,
  ListAdminUsersResponse,
  ResetPasswordResponse,
  SearchAdminUsersByEmailRequest,
  SearchAdminUsersByEmailResponse,
  UpdateAdminUserEmailRequest,
} from '../../schemas/admin/users';
