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

export const createHonoApp = (): OpenAPIHono<CrowiHonoBindings> => {
  const app = new OpenAPIHono<CrowiHonoBindings>({ defaultHook });
  app.onError(honoOnError);
  return app;
};

export { createCors, createJwtAuth, createJwtAdminRequired, defaultHook, honoOnError };
