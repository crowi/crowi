import { OpenAPIHono } from '@hono/zod-openapi';

import type { UserDocument } from 'src/models/user';

import { createJwtAdminRequired } from './middleware/admin';
import { createJwtAuth } from './middleware/auth';
import { createCors } from './middleware/cors';
import { defaultHook } from './middleware/default-hook';
import { honoOnError } from './middleware/error-handler';

/**
 * Variables exposed on Hono `Context` after the auth middleware has run.
 */
export interface CrowiHonoBindings {
  Variables: {
    user: UserDocument;
  };
}

/**
 * Header set by Hono's default `notFound` handler so the Express bridge
 * (kept in `routes/index.ts` for the supertest-based test suite — see
 * the comment there) can tell "no Hono route matched" from a
 * handler-emitted 404 like `PAGE_NOT_FOUND`. Production traffic does
 * not reach the bridge (Hono owns `http.Server` and overrides
 * `notFound` with `callExpressAsFetch`), so this marker is purely a
 * test-side convenience. Sub-batch D removes it together with the
 * bridge.
 */
export const HONO_UNMATCHED_HEADER = 'x-hono-unmatched';

export const createHonoApp = (): OpenAPIHono<CrowiHonoBindings> => {
  const app = new OpenAPIHono<CrowiHonoBindings>({ defaultHook });
  app.onError(honoOnError);
  // Tag the default 404 so the test bridge can distinguish unmatched
  // routes from handler-emitted 404s. Production `start()` overrides
  // this `notFound` after `buildHonoApp` returns so the marker never
  // appears on real traffic.
  app.notFound((c) => {
    c.header(HONO_UNMATCHED_HEADER, '1');
    return c.body(null, 404);
  });
  return app;
};

export { createCors, createJwtAuth, createJwtAdminRequired, defaultHook, honoOnError };
