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
 * extending the chain without breaking the typed client's inference
 * (Phase 3 smoke-test guarantee — see
 * `docs/migrations/0006-hono-context.md` §11).
 */
import { API_SURFACE_VERSION, type AppInfoResponse, type Capability, DYNAMIC_CAPABILITIES, getAppInfoRoute, STATIC_CAPABILITIES } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';

import type Crowi from 'src/crowi';
import { coerceBoolean, getCrowiConfigNamespace } from 'src/util/admin-config';

import type { CrowiHonoBindings } from '../app';

// Named refs into DYNAMIC_CAPABILITIES (`@crowi/api-contract`) so the tags
// below are never re-typed as bare string literals in the handler. Positional
// — must track DYNAMIC_CAPABILITIES's declared order (`search`, `collab`,
// `collab:redis`, `link-card`) in app-capabilities.ts exactly.
const [CAPABILITY_SEARCH, CAPABILITY_COLLAB, CAPABILITY_COLLAB_REDIS, CAPABILITY_LINK_CARD] = DYNAMIC_CAPABILITIES;

/**
 * Build the coarse capability list advertised at `GET /app/info`. Static
 * always-on subsystems plus cheap, in-memory dynamic probes:
 *   - `search` when a search driver is active (`getSearcher() !== null`);
 *     otherwise `GET /search` returns 503 and the CLI can pre-empt it.
 *   - `collab` always (Hocuspocus is library-attached unconditionally);
 *     `collab:redis` additionally when `REDIS_URL` is set so multi-instance
 *     pub/sub is wired up.
 *   - `link-card` (feature-renderer-plugin-boundary Phase 3) when the
 *     admin Security `security:linkCardEnabled` toggle reads true — same
 *     `coerceBoolean(value, true)` default-on-missing/non-boolean read
 *     used by the admin Security GET handler and the core `card` embed
 *     renderer's live per-dispatch check.
 * No I/O — all probes read state already held on the Crowi instance. The
 * `Capability[]` return type keeps this compiler-checked against
 * `@crowi/api-contract`'s vocabulary (a typo wouldn't be assignable to
 * `Capability`) — see `app-capabilities.ts` for the shared source of truth
 * (`DYNAMIC_CAPABILITIES`).
 */
const buildCapabilities = (crowi: Crowi): Capability[] => {
  const capabilities: Capability[] = [...STATIC_CAPABILITIES];
  if (crowi.getSearcher() != null) {
    capabilities.push(CAPABILITY_SEARCH);
  }
  capabilities.push(CAPABILITY_COLLAB);
  if (crowi.redis != null) {
    capabilities.push(CAPABILITY_COLLAB_REDIS);
  }
  if (coerceBoolean(getCrowiConfigNamespace(crowi)['security:linkCardEnabled'], true)) {
    capabilities.push(CAPABILITY_LINK_CARD);
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
    // Public UX hint for the unauthenticated login / register pages: is
    // self-service registration open? `Open` / `Restricted` → true,
    // `Closed` (invite-only) → false. The decision is the single
    // `!== 'Closed'` comparison, so it is unaffected by the historical
    // `Resricted` typo of the stored mode value, and the mode string
    // itself is never exposed (only this boolean). The real guard still
    // lives in `POST /auth/register` (403 REGISTRATION_CLOSED); the web
    // may fail-open on this flag.
    const registrationMode = config?.crowi?.['security:registrationMode'] as string | undefined;
    const canSelfRegister = registrationMode !== 'Closed';
    // Version-skew / feature-detection signal for the @crowi/cli end-user
    // CLI (and any other client). `crowi.version` is the @crowi/api
    // package.json version read at boot.
    // feature-renderer-plugin-boundary Phase 1 — the committed renderer
    // stylesheet manifest (`RendererRegistryImpl.getStylesheets()`, see its
    // doc comment for the pending→commit-on-route-success rule). `crowi.
    // renderer` is always set by request time (`setupRenderer` runs during
    // `Crowi.init()`, well before `buildHonoApp` mounts this route), but the
    // optional-chain keeps this handler from throwing in a minimal test
    // harness that skips renderer setup.
    const rendererStylesheets = [...(crowi.renderer?.registry.getStylesheets() ?? [])];
    return c.json(
      {
        title,
        confidential,
        version: crowi.version,
        apiVersion: API_SURFACE_VERSION,
        capabilities: buildCapabilities(crowi),
        canSelfRegister,
        rendererStylesheets,
      } satisfies AppInfoResponse,
      200,
    );
  });
