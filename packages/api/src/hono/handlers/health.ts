import type { OpenAPIHono } from '@hono/zod-openapi';
import type Crowi from 'src/crowi';
import { isServerDraining } from '../../util/server-lifecycle';
import type { CrowiHonoBindings } from '../app';

export type HealthCrowi = Pick<Crowi, 'isMongoConnected'>;

/**
 * Plain (non-OpenAPI) liveness / readiness routes. The body deliberately
 * carries a single `status` key so an unauthenticated caller learns nothing
 * about which dependency is down.
 */
export function registerHealthRoutes(app: OpenAPIHono<CrowiHonoBindings>, crowi: HealthCrowi): void {
  app.get('/healthz', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ status: 'ok' }, 200);
  });

  app.get('/readyz', (c) => {
    c.header('Cache-Control', 'no-store');
    if (isServerDraining(crowi) || !crowi.isMongoConnected()) {
      return c.json({ status: 'unavailable' }, 503);
    }
    return c.json({ status: 'ok' }, 200);
  });
}
