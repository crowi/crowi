/**
 * RFC-0006 Phase 4 Batch 9 — `admin.*` sub-contracts ported to
 * `@hono/zod-openapi` route definitions.
 *
 * The legacy ts-rest `adminContract` aggregator (a `c.router({ app, auth,
 * security, mail, share, storage, search, users, plugins })`) is gone.
 * Each sub-contract now exports a `createRoute(...)` set under
 * `adminXxxRoutes`, mirrored on the runtime side by an
 * `hono/handlers/admin/<sub>.ts` register function.
 *
 * Every admin route path begins with `/admin/` — asserted by the unit
 * test in `admin/index.test.ts` (RFC open question 4).
 */
export * from './app';
export * from './auth';
export * from './mail';
export * from './plugins';
export * from './search';
export * from './security';
export * from './share';
export * from './storage';
export * from './users';
