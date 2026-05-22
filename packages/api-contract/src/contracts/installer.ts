/**
 * RFC-0006 Phase 4 (Batch 1) — `installer` resource ported to
 * `@hono/zod-openapi` route definitions. Wire-format is preserved from
 * the ts-rest era: `GET /installer` returns `{ status: 'installer_required'
 * | 'already_installed' }`, and `POST /installer/createAdmin` returns
 * `{ status: 'ok' | 'error', message?, errors? }` (HTTP 200 for both arms
 * because the legacy controller chose HTTP 200 even on creation failure;
 * the dedicated 400 branch is reserved for the "already installed" guard).
 */
import { createRoute } from '@hono/zod-openapi';

import { CreateAdminRequestSchema, CreateAdminResponseSchema, InstallerStatusResponseSchema } from '../schemas/installer';
import { InternalServerErrorSchema } from '../schemas/common';

export const getInstallerStatusRoute = createRoute({
  method: 'get',
  path: '/installer',
  tags: ['installer'],
  summary: 'Get installer status',
  responses: {
    200: {
      description: 'Installer status',
      content: {
        'application/json': {
          schema: InstallerStatusResponseSchema,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: InternalServerErrorSchema,
        },
      },
    },
  },
});

export const createAdminRoute = createRoute({
  method: 'post',
  path: '/installer/createAdmin',
  tags: ['installer'],
  summary: 'Create initial admin user',
  request: {
    body: {
      content: {
        'application/json': {
          schema: CreateAdminRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Admin creation result (status=ok on success, status=error on validation failure)',
      content: {
        'application/json': {
          schema: CreateAdminResponseSchema,
        },
      },
    },
    400: {
      description: 'Application is already installed',
      content: {
        'application/json': {
          schema: CreateAdminResponseSchema,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: InternalServerErrorSchema,
        },
      },
    },
  },
});

export const installerRoutes = { getInstallerStatusRoute, createAdminRoute };
