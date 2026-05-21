/**
 * Hono port of the Express `jwtAdminRequired` middleware. Chains
 * `createJwtAuth(crowi)` so `c.get('user')` is populated, then enforces
 * `user.admin === true`, returning 403 `ADMIN_REQUIRED` on failure. Wire
 * shape matches `AdminRequiredErrorSchema`.
 *
 * Implementation note: the inner `jwtAuth` middleware uses `c.json(...)`
 * which **returns a Response without setting it on `c.res`**, so when
 * jwtAuth short-circuits (no token / expired token / inactive user)
 * the returned Response must be forwarded up the chain. We capture it
 * inline and return whichever short-circuit happens first (jwtAuth's
 * 401/403 or our own ADMIN_REQUIRED 403).
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
    let shortCircuit: Response | undefined;
    const jwtResult = await jwtAuth(c, async () => {
      const user = c.get('user');
      if (!user?.admin) {
        shortCircuit = c.json(ADMIN_REQUIRED_BODY, 403);
        return;
      }
      await next();
    });
    // jwtAuth returned a Response (= it short-circuited with 401/403)
    // and never invoked our inner callback. Forward that response.
    if (shortCircuit) return shortCircuit;
    if (jwtResult instanceof Response) return jwtResult;
    return;
  });
};
