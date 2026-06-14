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

/**
 * Subsystems unconditionally compiled into `@crowi/api`. An old CLI
 * talking to a new server, and a new CLI talking to a server that omits
 * `capabilities`, both degrade to this baseline. OAuth (RFC-0010) is
 * fully landed and the page / comment / bookmark / attachment /
 * notification handlers are always mounted, so these are always-on.
 */
const STATIC_CAPABILITIES = [
  'oauth',
  'oauth:auth-code',
  'oauth:device',
  'oauth:pkce',
  'pat',
  'pages',
  'comments',
  'bookmarks',
  'attachments',
  'notifications',
] as const;

/**
 * Build the coarse capability list advertised at `GET /app/info`. Static
 * always-on subsystems plus cheap, in-memory dynamic probes:
 *   - `search` when a search driver is active (`getSearcher() !== null`);
 *     otherwise `GET /search` returns 503 and the CLI can pre-empt it.
 *   - `collab` always (Hocuspocus is library-attached unconditionally);
 *     `collab:redis` additionally when `REDIS_URL` is set so multi-instance
 *     pub/sub is wired up.
 * No I/O — both probes read state already held on the Crowi instance.
 */
const buildCapabilities = (crowi: Crowi): string[] => {
  const capabilities: string[] = [...STATIC_CAPABILITIES];
  if (crowi.getSearcher() != null) {
    capabilities.push('search');
  }
  capabilities.push('collab');
  if (crowi.redis != null) {
    capabilities.push('collab:redis');
  }
  return capabilities;
};

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
    // Version-skew / feature-detection signal for the @crowi/cli end-user
    // CLI (and any other client). `crowi.version` is the @crowi/api
    // package.json version read at boot.
    return c.json(
      {
        title,
        confidential,
        version: crowi.version,
        apiVersion: 'v2',
        capabilities: buildCapabilities(crowi),
      },
      200,
    );
  });
