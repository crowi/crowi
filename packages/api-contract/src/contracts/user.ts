/**
 * RFC-0006 Phase 4 Batch 2 — `user` resource ported to
 * `@hono/zod-openapi` route definitions. Three endpoints:
 *
 *   GET /user/:username             — public profile + recent activity
 *   GET /user/:username/bookmarks   — paginated bookmark list
 *   GET /user/:username/pages       — paginated created-page list
 *
 * All three require JWT authentication and 404 on inactive / unknown
 * users; the Hono handler applies the shared `createJwtAuth` middleware
 * to `/user/*` so `c.get('user')` always resolves to the current user.
 *
 * Query parameters (`limit`, `offset`) reuse `PaginationRequestSchema`
 * with `z.coerce.number()` so callers can pass them as URL string params
 * — the contract surface stays byte-identical with the ts-rest era.
 */
import { createRoute, z } from '@hono/zod-openapi';

import { AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../schemas/common';
import {
  ListUsersRequestSchema,
  ListUsersResponseSchema,
  PaginationRequestSchema,
  UserBookmarksResponseSchema,
  UserNotFoundErrorSchema,
  UserPageResponseSchema,
  UserPagesResponseSchema,
} from '../schemas/user';

const UsernameParamSchema = z.object({ username: z.string() });

export const getUserPageRoute = createRoute({
  method: 'get',
  path: '/user/{username}',
  tags: ['user'],
  security: [{ bearerAuth: [] }],
  summary: 'Get user page information',
  request: {
    params: UsernameParamSchema,
  },
  responses: {
    200: {
      description: 'User profile with statistics + recent activity',
      content: { 'application/json': { schema: UserPageResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'User not found',
      content: { 'application/json': { schema: UserNotFoundErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const getUserBookmarksRoute = createRoute({
  method: 'get',
  path: '/user/{username}/bookmarks',
  tags: ['user'],
  security: [{ bearerAuth: [] }],
  summary: 'Get user bookmarks (paginated)',
  request: {
    params: UsernameParamSchema,
    query: PaginationRequestSchema,
  },
  responses: {
    200: {
      description: 'Paginated bookmarks',
      content: { 'application/json': { schema: UserBookmarksResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'User not found',
      content: { 'application/json': { schema: UserNotFoundErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const getUserPagesRoute = createRoute({
  method: 'get',
  path: '/user/{username}/pages',
  tags: ['user'],
  security: [{ bearerAuth: [] }],
  summary: 'Get pages created by the user (paginated)',
  request: {
    params: UsernameParamSchema,
    query: PaginationRequestSchema,
  },
  responses: {
    200: {
      description: 'Paginated created pages',
      content: { 'application/json': { schema: UserPagesResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'User not found',
      content: { 'application/json': { schema: UserNotFoundErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

// Member directory — list active users (avatar + name + @username) for the
// special `/user/` portal. Plural `/users` so it never collides with the
// `/user/{username}` profile routes. Authenticated, non-admin.
export const listMembersRoute = createRoute({
  method: 'get',
  path: '/users',
  tags: ['user'],
  security: [{ bearerAuth: [] }],
  summary: 'List active users for the member directory (paginated, searchable)',
  request: {
    query: ListUsersRequestSchema,
  },
  responses: {
    200: {
      description: 'Paginated active users, name-ascending',
      content: { 'application/json': { schema: ListUsersResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const userRoutes = {
  getUserPageRoute,
  getUserBookmarksRoute,
  getUserPagesRoute,
  listMembersRoute,
};
