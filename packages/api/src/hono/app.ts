import { OpenAPIHono } from '@hono/zod-openapi';

import type { UserDocument } from 'src/models/user';

import { createJwtAdminRequired } from './middleware/admin';
import { createJwtAuth } from './middleware/auth';
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
 * Header set by Hono's `notFound` handler so the Express bridge in
 * `routes/index.ts` can distinguish "Hono explicitly emitted a 404
 * from a handler" (forward verbatim) from "no Hono route matched"
 * (fall through to ts-rest). Phase 6 removes the bridge entirely
 * and this marker goes away with it.
 */
export const HONO_UNMATCHED_HEADER = 'x-hono-unmatched';

export const createHonoApp = (): OpenAPIHono<CrowiHonoBindings> => {
  const app = new OpenAPIHono<CrowiHonoBindings>({ defaultHook });
  app.onError(honoOnError);
  // Tag the default 404 so the bridge can tell it apart from a
  // handler-emitted 404 (e.g. `USER_NOT_FOUND`). Handlers that return
  // status 404 with `c.json(...)` do NOT trigger `notFound` — only an
  // unmatched path does.
  app.notFound((c) => {
    c.header(HONO_UNMATCHED_HEADER, '1');
    return c.body(null, 404);
  });
  return app;
};

export { createJwtAuth, createJwtAdminRequired, defaultHook, honoOnError };
