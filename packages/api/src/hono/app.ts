import { OpenAPIHono } from '@hono/zod-openapi';

import { createJwtAdminRequired } from './middleware/admin';
import { type HonoAuthVariables, createJwtAuth } from './middleware/auth';
import { createCors } from './middleware/cors';
import { defaultHook } from './middleware/default-hook';
import { honoOnError } from './middleware/error-handler';

/**
 * Variables exposed on Hono `Context` after the auth middleware has run.
 *
 * Kept in lock-step with `HonoAuthVariables` (middleware/auth.ts) — the
 * auth middleware sets `user` / `authScopes` / `authContext`, so the
 * binding must expose all three to every `register*Routes` handler and
 * the `requireScope` middleware.
 */
export interface CrowiHonoBindings {
  Variables: HonoAuthVariables;
}

export const createHonoApp = (): OpenAPIHono<CrowiHonoBindings> => {
  const app = new OpenAPIHono<CrowiHonoBindings>({ defaultHook });
  app.onError(honoOnError);
  return app;
};

export { createCors, createJwtAuth, createJwtAdminRequired, defaultHook, honoOnError };
