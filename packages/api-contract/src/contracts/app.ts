/**
 * RFC-0006 Phase 3 — `app` resource ported to `@hono/zod-openapi` route
 * definitions. The previous `c.router(...)` form (ts-rest) is gone; the
 * single `GET /app/info` route now lives as a `createRoute(...)` object
 * that the Hono handler in `packages/api/src/hono/handlers/app.ts`
 * consumes via `app.openapi(getAppInfoRoute, handler)`.
 *
 * Wire-format parity with the ts-rest era is preserved: the response is
 * still `AppInfoResponseSchema` (the schema file itself was untouched in
 * Phase 2's `import { z } from '@hono/zod-openapi'` swap).
 */
import { createRoute } from '@hono/zod-openapi';

import { InternalServerErrorSchema } from '../schemas/common';
import { AppInfoResponseSchema } from '../schemas/app';

export const getAppInfoRoute = createRoute({
  method: 'get',
  path: '/app/info',
  tags: ['app'],
  summary: 'Get public application info (site title etc.)',
  responses: {
    200: {
      description: 'Public application info',
      content: {
        'application/json': {
          schema: AppInfoResponseSchema,
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

export const appRoutes = { getAppInfoRoute };
