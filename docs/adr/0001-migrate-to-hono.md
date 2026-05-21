# ADR 0001 — Migrate the HTTP API framework from ts-rest to Hono

- **Status**: Accepted
- **Date**: 2026-05-21
- **Deciders**: Crowi maintainers
- **Related**: [RFC 0006](../rfcs/0006-hono-integration.md), [Discovery doc](../migrations/0006-hono-context.md)

## Context

Crowi's v2 API (`/api/v2/*`) was built on [ts-rest](https://ts-rest.com/),
combining a Zod schema package (`@crowi/api-contract`) with a ts-rest
Express adapter for the runtime and `@ts-rest/open-api` for spec
generation. The framework choice predates Crowi v2 reaching production.

Through Q4 2025 / Q1 2026 the foundation showed cracks:

- **Upstream maintenance signal**: ts-rest's last stable release was
  3.52.1 (March 2025). Issue [#797](https://github.com/ts-rest/ts-rest/issues/797)
  contains explicit acknowledgement from the maintainer that the
  project is in maintenance-only mode for the foreseeable future. The
  3.53.0 line has been a release-candidate for the better part of a
  year with no stable cut.
- **Zod v4 lock-in**: `@ts-rest/open-api` depends on `@anatine/zod-openapi`,
  which reads zod v3 internal shapes (`_def.typeName`,
  `ZodFirstPartyTypeKind`, `_def.checks`, etc.). When we tried to bump
  zod to v4 — required to use the modern `@hono/zod-openapi` series —
  the spec generator broke at runtime, not just at the peer level.
  There was no version combination that satisfied "ts-rest stays + zod
  v4 + OpenAPI generator still works".
- **OpenAPI 3.1 / multipart gaps**: ts-rest emits OpenAPI 3.0.2 and
  ships no first-class multipart helpers. Crowi's attachment + profile
  picture endpoints had to glue multer in by hand on the Express side,
  outside the contract type system.
- **Frontend client ergonomics**: `@ts-rest/react-query` returns a
  `{ status, body }` discriminated union per call, which became
  unwieldy as the frontend grew to ~50 hooks. Most hooks ended up
  re-implementing the same `if (result.status === 200) … else throw`
  ladder by hand.

We surveyed alternatives:

- **[oRPC](https://orpc.unnoq.com/)** — modern API, OpenAPI 3.1 native,
  good zod v4 story. Rejected: single-developer project with the same
  long-term sustainability profile as ts-rest, and adoption is still
  early.
- **Plain Express + Zod + hand-rolled OpenAPI** — viable but discards
  the contract package's main value (single source of truth for types
  on both sides). Would also require us to rebuild the type-safe
  client story from scratch.
- **[tRPC](https://trpc.io/)** — popular and well-funded, but the wire
  format is bespoke (RPC over POST). Migrating away from REST-shaped
  `/api/v2/*` would break every external integration and was explicitly
  out of scope.
- **[Hono](https://hono.dev/) + `@hono/zod-openapi`** — recommended.

## Decision

Adopt **Hono + `@hono/zod-openapi`** as the API framework. Specifically:

- **Runtime**: Hono on `@hono/node-server`. No Workers / Bun / Deno
  switch — Crowi remains a Node.js service.
- **Contracts**: Keep `@crowi/api-contract` as the contract package.
  Each endpoint switches from `c.router(...)` / contract entries to
  `createRoute(...)` definitions imported by both the api package
  (real handlers) and the api-contract package (no-op stub chain that
  carries `AppType`).
- **Client**: Frontend switches from `@ts-rest/react-query`'s
  `apiClient` to `hc<AppType>` (`apiClientV2`), keeping the same JWT
  refresh-token machinery on the underlying `fetch`.
- **OpenAPI**: 3.0.2 → 3.1.0. The spec is generated via
  `OpenAPIHono.getOpenAPI31Document(...)` and emitted to
  `packages/api-contract/openapi.{json,yaml}` as committed artefacts.
  An additional `openapi-typescript` step emits
  `packages/api-contract/src/generated/openapi.ts` for external /
  cross-language consumers. All three artefacts are CI-gated by
  `git diff --exit-code`.
- **Docs UI**: Scalar API Reference served at `/api/v2/docs`, fed by
  `/api/v2/openapi.json` (built from the live Hono chain so admins
  always see the running shape).
- **Multipart**: Hono-native `c.req.parseBody()`. Multer is removed
  from new handlers; the few remaining streaming attachment routes
  stay on Express until Phase 6's final cleanup removes Express
  entirely.
- **Zod**: Bump catalog from v3 to v4 in lockstep with the framework
  swap. `@hono/zod-openapi` 1.x requires zod v4, and the schemas
  needed only a handful of mechanical adjustments (`z.record(k, v)`,
  `z.any().optional()` for multipart bodies).
- **Migration strategy**: Resource-by-resource cutover with the Hono
  app mounted as an Express middleware at `/api/v2` for the duration
  of Phase 2-4, falling through to ts-rest only for resources that
  haven't moved yet. No parallel-run phase — ts-rest endpoints were
  not yet in production, so we delete them outright as Hono replaces
  them.

## Consequences

### Positive

- **Active upstream**: Hono is backed by the honojs org with multiple
  full-time maintainers and Cloudflare Workers as a tier-1 deployment
  target. The release cadence has been steady through 2025.
- **OpenAPI 3.1**: Native support, including `nullable` via `type:
  [..., 'null']` and JSON Schema 2020-12 alignment. Tools downstream
  (Scalar, openapi-typescript, code generators in other languages)
  receive a more accurate spec.
- **Multipart**: First-class. The attachment + profile picture
  endpoints are simpler and the contract describes the body shape
  directly.
- **Frontend ergonomics**: `hc<AppType>` returns a real `Response`
  object. Hooks read `response.ok` / `response.json()` and pass the
  body through a tiny `unwrap-result.ts` helper, eliminating the
  per-hook discriminated-union ladder.
- **Vendor-neutral escape hatch**: The committed OpenAPI 3.1 spec
  means that if Hono ever follows ts-rest into maintenance limbo, the
  spec itself is the contract — any framework that can serve it works.

### Negative / trade-offs

- **Zod v4 churn**: Anything in the codebase that consumed zod v3
  internals (a handful of plugin SDK serializers) had to be pinned
  to `zod/v3` (the compat namespace that ships inside zod v4) until
  those readers are rewritten. Net: a few `import { z } from 'zod/v3'`
  call sites in plugin internals.
- **`AppType` instantiation depth**: 90+ chained `.openapi(...)` calls
  push the TypeScript compiler past its default instantiation depth
  in `hc<AppType>` inference (TS2589). Phase 4 used a temporary
  `@ts-expect-error` + `CrowiApiClient = any` escape hatch in
  `packages/api-contract/src/client.ts`; Phase 6 splits the chain
  into independent sub-chains and intersects them to land a real
  inferred type. See the spec.md gate
  `grep -r 'TS2589-RFC-0006-PHASE-6'` for the marker tracker.
- **Express still present (Phase 6 in progress)**: Until the Express
  host is replaced by `serve({ fetch: honoApp.fetch, createServer:
  http.createServer })`, the Hono app runs as an Express middleware
  with a request/response bridge. The bridge re-buffers multipart
  bodies so they survive a fall-through to ts-rest if Hono doesn't
  claim a path. This dance disappears when Express does.
- **Plugin HTTP contribution parked**: The legacy `PluginRouterScope`
  surface depended on `@ts-rest/core`'s `AppRouter`. With ts-rest
  removed, plugin HTTP contribution becomes a no-op stub. No
  in-production plugin currently uses it (`registerRoutes` was
  never wired end-to-end), so the surface is reserved for a follow-up
  RFC that redesigns it on top of Hono.

## Status / follow-ups

- Phase 6 (this ADR's home phase) finishes the cleanup: Express host
  removal, legacy `/api/*` mount drop, Scalar UI, openapi-typescript,
  TS2589 escape-hatch removal, and the deps audit
  (`grep -r '@ts-rest' = 0` from package.json + source code, with the
  RFC / discovery doc retained as historical record).
- Phase 7 is a one-week soak on staging with no code changes.
- Plugin HTTP route contribution will be redesigned in a follow-up
  RFC once we have at least one in-tree plugin that genuinely needs
  it.
