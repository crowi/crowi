/**
 * RFC-0006 Phase 4 Batch 2 — `me` resource ported to `@hono/zod-openapi`
 * route definitions. Eight endpoints:
 *
 *   GET    /me                         — current user's profile
 *   PUT    /me                         — update profile (name/email/lang)
 *   POST   /me/picture                 — upload profile picture (multipart)
 *   DELETE /me/picture                 — clear profile picture
 *   PUT    /me/password                — change password (or set initial)
 *   GET    /me/recently-viewed-pages   — recently viewed page list
 *
 * Personal access token management (RFC-0010, replacing the legacy
 * `GET/POST /me/apiToken`) lives in `./access-token.ts`.
 *
 * All endpoints require JWT authentication. The handler applies the
 * shared `createJwtAuth(crowi)` middleware to `/me/*` (broad apply) so
 * every route below sees `c.get('user')` populated with a `UserDocument`.
 *
 * Multipart picture upload uses Hono-native `c.req.parseBody()` rather
 * than `multer` (discovery doc §5 decision); the legacy form-field name
 * `file` is preserved so existing clients (web `<input name="file">`)
 * keep working.
 */
import { createRoute, z } from '@hono/zod-openapi';

import {
  PasswordErrorResponseSchema,
  PasswordUpdateSuccessSchema,
  PictureUploadResponseSchema,
  ProfileErrorResponseSchema,
  RecentlyViewedPagesResponseSchema,
  SuccessResponseSchema,
  ThemeUpdateResponseSchema,
  UpdatePasswordRequestSchema,
  UpdateProfileRequestSchema,
  UpdateThemeRequestSchema,
  UserProfileResponseSchema,
} from '../schemas/me';
import { AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../schemas/common';

export const getProfileRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['me'],
  security: [{ bearerAuth: [] }],
  summary: 'Get current user profile',
  responses: {
    200: {
      description: 'Current user profile',
      content: { 'application/json': { schema: UserProfileResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
  },
});

export const updateProfileRoute = createRoute({
  method: 'put',
  path: '/me',
  tags: ['me'],
  security: [{ bearerAuth: [] }],
  summary: 'Update profile',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateProfileRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated profile',
      content: { 'application/json': { schema: UserProfileResponseSchema } },
    },
    400: {
      description: 'Profile update failed',
      content: { 'application/json': { schema: ProfileErrorResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
  },
});

export const updateThemeRoute = createRoute({
  method: 'patch',
  path: '/me/theme',
  tags: ['me'],
  security: [{ bearerAuth: [] }],
  summary: 'Update preferred UI theme',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateThemeRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Theme updated',
      content: { 'application/json': { schema: ThemeUpdateResponseSchema } },
    },
    400: {
      description: 'Theme update failed',
      content: { 'application/json': { schema: ProfileErrorResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
  },
});

export const uploadPictureRoute = createRoute({
  method: 'post',
  path: '/me/picture',
  tags: ['me'],
  security: [{ bearerAuth: [] }],
  summary: 'Upload profile picture',
  request: {
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({
            file: z.any().optional().describe('Profile picture file'),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Picture uploaded',
      content: { 'application/json': { schema: PictureUploadResponseSchema } },
    },
    400: {
      description: 'Upload failed',
      content: { 'application/json': { schema: ProfileErrorResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
  },
});

export const deletePictureRoute = createRoute({
  method: 'delete',
  path: '/me/picture',
  tags: ['me'],
  security: [{ bearerAuth: [] }],
  summary: 'Delete profile picture',
  responses: {
    200: {
      description: 'Picture deleted',
      content: { 'application/json': { schema: SuccessResponseSchema } },
    },
    400: {
      description: 'Delete failed',
      content: { 'application/json': { schema: ProfileErrorResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
  },
});

export const updatePasswordRoute = createRoute({
  method: 'put',
  path: '/me/password',
  tags: ['me'],
  security: [{ bearerAuth: [] }],
  summary: 'Update password',
  request: {
    body: {
      content: { 'application/json': { schema: UpdatePasswordRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Password updated; earlier sessions revoked and a fresh token pair issued',
      content: { 'application/json': { schema: PasswordUpdateSuccessSchema } },
    },
    400: {
      description: 'Password update failed',
      content: { 'application/json': { schema: PasswordErrorResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
  },
});

export const recentlyViewedPagesRoute = createRoute({
  method: 'get',
  path: '/me/recently-viewed-pages',
  tags: ['me'],
  security: [{ bearerAuth: [] }],
  summary: "Get the current user's recently-viewed pages",
  responses: {
    200: {
      description: 'Recently-viewed pages list (up to 5)',
      content: { 'application/json': { schema: RecentlyViewedPagesResponseSchema } },
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

export const meRoutes = {
  getProfileRoute,
  updateProfileRoute,
  updateThemeRoute,
  uploadPictureRoute,
  deletePictureRoute,
  updatePasswordRoute,
  recentlyViewedPagesRoute,
};
