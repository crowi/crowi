import { z } from '@hono/zod-openapi';

import { CapabilitySchema } from './app-capabilities';

/**
 * Public application info shared with every authenticated page (header,
 * page title, etc.). Sensitive config never appears here.
 *
 * `title` is `null` when the operator has not set a custom site title
 * (i.e. the value still matches the seed default). Clients can use this
 * to switch between the full Crowi lockup and a `[icon] + custom title`
 * presentation.
 *
 * `confidential` is the optional confidentiality notice text the operator
 * sets in admin (`app:confidential`). It is `null` when unset/empty; when
 * present the web shell renders it as an always-on header banner so the
 * notice shows on screenshots / printouts (corporate IT requirement).
 *
 * `version` is the running Crowi server version (the `@crowi/api` package
 * version). `apiVersion` is the API surface version (currently always
 * `API_SURFACE_VERSION` = `"v2"`, from `./app-capabilities`) — kept as
 * `z.string()` rather than `z.literal(API_SURFACE_VERSION)` on purpose: the
 * `@crowi/cli` end-user CLI parses this response with
 * `AppInfoResponseSchema.partial().safeParse(body)` to implement its
 * WARN-ONLY version-skew note (`packages/cli/src/lib/capability.ts`), and a
 * `.partial()` object schema still rejects the WHOLE parse (not just the
 * mismatched field) when a present field fails its own validator. A literal
 * `apiVersion` would make that safeParse fail outright the moment a future
 * server advertises a different surface version — exactly the skew case the
 * CLI needs to detect and warn about, not silently swallow. `capabilities`
 * does not have this hazard today (no currently-shipped client sends an
 * out-of-vocabulary tag), so it is the strict `CapabilitySchema` enum: a
 * coarse list of subsystems the server exposes — unconditionally-compiled
 * features plus dynamically-detected ones (e.g. `"search"` only when a
 * search driver is active). Together these three fields are the
 * version-skew / feature-detection signal the CLI reads from this public,
 * unauthenticated endpoint. The CLI parses them leniently: an older server
 * that omits them degrades to a static baseline with version-skew warnings
 * suppressed.
 *
 * `canSelfRegister` tells the unauthenticated login / register pages
 * whether self-service registration is open, so the web can hide the
 * `/register` form (and the login → register link) up front instead of
 * letting users fill the form and only learn it is closed on a 403. It is
 * `true` for the `Open` / `Restricted` registration modes and `false` for
 * `Closed` (invite-only). Only the boolean is exposed — the internal mode
 * string (whose stored value is the historical `Resricted` typo) is never
 * surfaced. The API still enforces the real guard (403
 * `REGISTRATION_CLOSED` on `POST /auth/register`); this flag is a UX hint
 * the front-end may fail-open on.
 *
 * `rendererStylesheets` (feature-renderer-plugin-boundary Phase 1) is the
 * boot-time CSS-asset manifest: API-relative absolute paths
 * (`/api/v2/plugins/<plugin-name>/…`) that renderer plugins registered via
 * `RendererRegistry.addStylesheet(path)` AND whose `registerRoutes` mounted
 * successfully (see `RendererRegistryImpl.commitStylesheets`,
 * `packages/api/src/renderer/registry.ts`) — a plugin whose route mount
 * failed, or that never registered routes at all, never appears here. The
 * web `RendererStylesheets` component resolves each path through the same
 * runtime API-origin resolver as every other API call
 * (`resolveApiUrl`, `packages/web/src/lib/api-client.ts`) and injects a
 * `<link rel="stylesheet">` per entry. Order is commit order (plugin
 * activation order); entries are deduped. Empty when no loaded plugin
 * registered a stylesheet.
 */
export const AppInfoResponseSchema = z.object({
  title: z.string().nullable(),
  confidential: z.string().nullable(),
  version: z.string(),
  apiVersion: z.string(),
  capabilities: z.array(CapabilitySchema),
  canSelfRegister: z.boolean(),
  rendererStylesheets: z.array(z.string()),
});
export type AppInfoResponse = z.infer<typeof AppInfoResponseSchema>;
