/**
 * Hono port of the Express `jwtAdminRequired` middleware. Chains
 * `createJwtAuth(crowi)` so `c.get('user')` is populated, then enforces
 * `user.admin === true`, returning 403 `ADMIN_REQUIRED` on failure. Wire
 * shape matches `AdminRequiredErrorSchema`.
 */
import type { AdminRequiredErrorSchema } from '@crowi/api-contract';
import { createMiddleware } from 'hono/factory';
import type { z } from 'zod';

import type Crowi from 'src/crowi';

import { type HonoAuthVariables, createJwtAuth } from './auth';

type AdminRequiredError = z.infer<typeof AdminRequiredErrorSchema>;

const ADMIN_REQUIRED_BODY: AdminRequiredError = {
  error: {
    code: 'ADMIN_REQUIRED',
    message: 'Admin permission required',
  },
};

export const createJwtAdminRequired = (crowi: Crowi) => {
  const jwtAuth = createJwtAuth(crowi);

  return createMiddleware<{ Variables: HonoAuthVariables }>(async (c, next) => {
    let adminCheckResponse: Response | undefined;
    await jwtAuth(c, async () => {
      const user = c.get('user');
      if (!user?.admin) {
        adminCheckResponse = c.json(ADMIN_REQUIRED_BODY, 403);
        return;
      }
      await next();
    });
    return adminCheckResponse;
  });
};
