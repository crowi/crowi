/**
 * `admin.artifact` sub-contract.
 *
 *   GET /admin/artifact  — read the effective delivery mode + stored settings
 *   PUT /admin/artifact  — persist the 3 `artifact:policy` fields
 *
 * Auth:
 *   - The handler installs `createJwtAdminRequired(crowi)` on
 *     `/admin/artifact/*` and the bare `/admin/artifact` path, same as
 *     `admin.security`.
 */
import { createRoute, z } from '@hono/zod-openapi';

import {
  ArtifactSettingsRejectedErrorSchema,
  GetArtifactSettingsResponseSchema,
  UpdateArtifactSettingsRequestSchema,
  UpdateArtifactSettingsResponseSchema,
} from '../../schemas/admin/artifact';
import { AdminRequiredErrorSchema, AuthenticationRequiredErrorSchema, InternalServerErrorSchema, ValidationErrorSchema } from '../../schemas/common';

export const getArtifactSettingsRoute = createRoute({
  method: 'get',
  path: '/admin/artifact',
  tags: ['admin.artifact'],
  security: [{ bearerAuth: [] }],
  summary: 'Get the current HTML artifact delivery mode and settings',
  responses: {
    200: {
      description: 'Current artifact delivery mode and settings',
      content: { 'application/json': { schema: GetArtifactSettingsResponseSchema } },
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

export const updateArtifactSettingsRoute = createRoute({
  method: 'put',
  path: '/admin/artifact',
  tags: ['admin.artifact'],
  security: [{ bearerAuth: [] }],
  summary: 'Update HTML artifact delivery settings (sameOriginEnabled / allowWebFonts / maxBytes)',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateArtifactSettingsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated settings (re-resolved from in-memory cache)',
      content: { 'application/json': { schema: UpdateArtifactSettingsResponseSchema } },
    },
    400: {
      description: 'Validation failure or a same-origin toggle rejected for missing CLIENT_URL',
      content: { 'application/json': { schema: z.union([ValidationErrorSchema, ArtifactSettingsRejectedErrorSchema]) } },
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

export const adminArtifactRoutes = {
  getArtifactSettingsRoute,
  updateArtifactSettingsRoute,
};

export type {
  ArtifactDeliveryMode,
  ArtifactSameOriginInactiveReason,
  ArtifactSettings,
  GetArtifactSettingsResponse,
  UpdateArtifactSettingsRequest,
  UpdateArtifactSettingsResponse,
} from '../../schemas/admin/artifact';
