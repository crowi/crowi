/**
 * RFC-0006 Phase 3 pilot — `app` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/app.ts`. The handler logic
 * is reproduced byte-for-byte (same `'Crowi'` sentinel rule for the
 * default site title), but the integration shape is now `app.openapi(
 * route, handler)` chaining against the route definition in
 * `@crowi/api-contract`'s `contracts/app.ts`.
 *
 * The function returns the chained `OpenAPIHono` so callers can keep
 * extending the chain without breaking `AppType` inference (Phase 3
 * smoke-test guarantee — see `docs/migrations/0006-hono-context.md`
 * §11).
 */
import { getAppInfoRoute } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';

import type Crowi from 'src/crowi';

import type { CrowiHonoBindings } from '../app';

export const registerAppRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) =>
  app.openapi(getAppInfoRoute, (c) => {
    const config = crowi.getConfig();
    const raw = config?.crowi?.['app:title'] as string | undefined;
    // 'Crowi' is the seed default in models/config.ts; treat that and
    // empty/missing values as "not customized" so the client can render
    // the full lockup instead of an icon-plus-text composition.
    const title = raw && raw !== 'Crowi' ? raw : null;
    // Confidentiality notice (app:confidential) rides the same public
    // channel so the (auth) shell can render an always-on header banner.
    // Empty/missing collapses to null (banner hidden).
    const confidentialRaw = config?.crowi?.['app:confidential'] as string | undefined;
    const confidential = confidentialRaw ? confidentialRaw : null;
    return c.json({ title, confidential }, 200);
  });
