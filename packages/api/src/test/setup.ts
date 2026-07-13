/**
 * RFC-0006 Phase 6 Sub-batch D — test harness for the Hono-only api.
 *
 * Express has been removed; the api now boots Hono via
 * `@hono/node-server`'s `createAdaptorServer`. Supertest accepts any
 * Node `RequestListener` `(req, res) => void`, so we expose one by
 * piping through `getRequestListener(honoApp.fetch)` from
 * `@hono/node-server`.
 *
 * Path rewrite: the OpenAPI contracts register every route at its
 * **unprefixed** path (`/app/info`, `/pages/:id`, ...), and the
 * production server reaches them via the URL rewriter in
 * `crowi/index.ts:start()` that strips a leading `/api/v2`. Tests
 * invariably dial `/api/v2/...`, so we install the same rewrite here
 * — it keeps every existing supertest call site working without
 * change.
 */
import { getRequestListener } from '@hono/node-server';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Crowi from 'src/crowi';
import { buildHonoApp } from 'src/hono';
import { stripApiV2Prefix } from 'src/hono/path-rewrite';

import { bootCrowiWithRetry } from './db-connect-retry';

// Silence boot-time noise that fires once per test file and drowns
// the actual ✓ / ✕ output in the jest report:
//
//   `[crowi] Loaded N plugin(s): ...`         — PluginManager boot log
//   `[crowi] CROWI_ENCRYPTION_KEY is not set` — setupEncryption legacy
//                                               fallback (the test env
//                                               injects a dummy key,
//                                               but tests that delete
//                                               the env still trip it)
//   `[crowi] Migrated N legacy ...`           — one-shot config migrator
//
// We patch console.log + console.warn once at module load so every
// test file inherits the filter without per-test setup. Production
// boot still emits everything.
{
  const QUIET_PREFIXES = ['[crowi] '];
  const isQuiet = (args: unknown[]) => typeof args[0] === 'string' && QUIET_PREFIXES.some((prefix) => (args[0] as string).startsWith(prefix));

  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    if (isQuiet(args)) return;
    originalLog(...args);
  };

  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (isQuiet(args)) return;
    originalWarn(...args);
  };
}

export let crowi: Crowi;
/**
 * Node `RequestListener` (`(req, res) => void`) backed by the Hono
 * app. Acceptable input to `supertest(app)` — every existing
 * `request(app).get('/api/v2/...')` call works as before because the
 * `/api/v2` prefix is stripped inline before Hono dispatches.
 */
export let app: (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Response barrier (test harness only).
 *
 * In PRODUCTION a response returns while its fire-and-forget side
 * effects (backlink / auto-watch / Activity→Notification fan-out,
 * render-cache invalidation, mention dispatch, user-page creation) are
 * still in flight. In tests that timing is the dominant flake source:
 * assertions race the fan-out under parallel-worker load (~1/15 of full
 * runs lost a different single fan-out test).
 *
 * Every side effect is routed through `crowi.trackSideEffect()` (see
 * feature-test-flake-hardening Phase 1), and the handler's emit() runs
 * synchronously inside the awaited fetch — so by the time
 * `honoApp.fetch` resolves, all first-level effects are in the tracked
 * set, and `drainSideEffects()` loops until multi-level chains settle
 * too. Draining at the fetch boundary (see `fetchFn` in `beforeAll`)
 * lets a test assume: "the response returned ⇒ every side effect of
 * that request has settled" — positive AND negative assertions become
 * deterministic without per-test waiting code.
 *
 * Escape hatch: flip `responseBarrier.enabled = false` (per-file /
 * per-block, restored in `afterAll`) to observe the intermediate state
 * — response returned, fan-out not yet complete — at the HTTP level. A
 * block that opts out owns its own waiting (`waitForModel` etc.). The
 * flag is module-local per jest file, so it never leaks across files;
 * only same-file blocks must restore it.
 *
 * CAVEAT (read before debugging "passes in test, races in prod"): this
 * deliberately DIVERGES from production timing semantics. A real client
 * reading immediately after a write may still see pre-fan-out state in
 * production. Tests cannot catch that class of read-after-write race
 * while the barrier is on — that contract gap is production
 * architecture work (side-effect scheduler RFC), not a test concern.
 */
export const responseBarrier = { enabled: true };

// @ts-ignore
export const ROOT_DIR = global.ROOT_DIR as string;
// @ts-ignore
export const MODEL_DIR = global.MODEL_DIR as string;
// @ts-ignore
export const MONGO_URI = global.MONGO_URI as string;
// @ts-ignore
export const MONGO_DB_NAME = global.MONGO_DB_NAME as string;

// The `beforeAll` below boots a full Crowi (`crowi.init()` — encryption,
// DB connect, models, redis, config) and builds the Hono app, once per
// test file. On constrained CI runners — and especially with other
// workspaces' jest suites running concurrently — that comfortably
// exceeds Jest's default 5s hook timeout. Raise the default for every
// hook/test in this project's files; a genuine hang still fails, just
// later. (A project-level `testTimeout` in jest.config.js is NOT
// honoured for hooks registered from a setupFilesAfterEnv module, so
// the timeout has to be set here.)
jest.setTimeout(60000);

// This `beforeAll` alone gets a longer explicit timeout (90000ms, the
// second argument below) than the file default set above: the bounded
// connect retry it runs (see immediately below) can take up to 2 attempts
// x the driver's default 30000ms `serverSelectionTimeoutMS` plus one
// backoff (~62s worst case) before the rest of `crowi.init()`'s boot
// layers even start. See `db-connect-retry.ts`'s `BEFORE_ALL_HOOK_TIMEOUT_MS`
// doc comment for the exact arithmetic. `afterAll`'s explicit `60000`
// below is unchanged.
beforeAll(async () => {
  // Bounded connect retry (feature-test-parallel-db-flake-hardening Phase 1
  // / A1-1): `setupDatabase()` itself is unchanged (still a one-shot
  // `mongoose.connect()`, same as production) — `bootCrowiWithRetry` only
  // wraps the test-harness side of it, retrying at most once and only for
  // a failure it can prove (a) came from `setupDatabase()`'s connect step
  // and (b) carries transient-network evidence. See `db-connect-retry.ts`
  // for the full classification + retry-budget writeup.
  //
  // `expect.getState().testPath` identifies the file for the console.warn
  // + JSON Lines side-channel event a retry emits; it's set by the circus
  // runner before `setupFilesAfterEnv` modules load, so it's always
  // available here.
  const testFilePath = expect.getState().testPath ?? 'unknown-test-file';
  crowi = await bootCrowiWithRetry(
    () =>
      // Spread process.env FIRST and then layer the test-harness values on
      // top. The original order (`{ ...test, ...process.env }`) silently
      // let an externally-set `MONGO_URI` (e.g. the CI's `mongodb://
      // localhost:27017` from the docker `mongo` service) override the
      // crowi-environment.js per-file db, which collapses every parallel
      // jest worker onto a single shared database and recycles Config
      // documents from previous runs across test files.
      new Crowi(ROOT_DIR, {
        ...process.env,
        PORT: '13001',
        MONGO_URI: MONGO_URI,
        BASE_URL: 'http://localhost:13001',
        // Public origin (used by getBaseUrl() for CORS + mail links).
        CLIENT_URL: 'http://localhost:13001',
      }),
    testFilePath,
    // Assign the module-level `crowi` binding on EVERY attempt, before
    // `init()` is awaited — not just on eventual success. Mirrors the
    // pre-retry code's `crowi = new Crowi(...); await crowi.init();`
    // ordering (where `crowi` held a real, if not fully initialized,
    // instance even when `init()` threw). Without this, a failure that
    // exhausts all retries (or is non-retryable) would leave `crowi`
    // unassigned, and `afterAll` below would throw on `crowi.drainSideEffects()`
    // / `crowi.teardownForCli()` — masking the real boot failure with an
    // unrelated "Cannot read properties of undefined" and skipping
    // whatever partial cleanup the instance could still do (e.g. quitting
    // a redis client the connect-retry-triggering failure left open).
    (instance) => {
      crowi = instance;
    },
  );

  const honoApp = buildHonoApp(crowi);
  // Wrap `honoApp.fetch` so the `/api/v2` prefix in supertest URLs is
  // stripped before Hono dispatches. Mirrors the rewrite that
  // `crowi/index.ts:start()` applies on the production listener.
  //
  // Response barrier: when enabled, drain tracked fire-and-forget side
  // effects AFTER `honoApp.fetch` resolves but BEFORE returning the
  // response (see `responseBarrier` doc comment above). The handler's
  // emit() runs synchronously inside the awaited fetch, so by the time
  // it resolves every first-level effect is in the tracked set, and
  // `drainSideEffects()` loops until multi-level chains settle too.
  // Side-effect-free requests (e.g. rate-limit 429 floods) hit the
  // fast path: the set is empty, so the drain's `while` is false on the
  // first check and resolves effectively synchronously.
  const fetchFn = async (request: Request): Promise<Response> => {
    const res = await honoApp.fetch(stripApiV2Prefix(request));
    if (responseBarrier.enabled) {
      await crowi.drainSideEffects();
    }
    return res;
  };
  app = getRequestListener(fetchFn);
}, 90000);

// Between tests, drain any in-flight fire-and-forget side effects (event
// listeners + Mongoose post('save') hooks that start un-awaited DB/redis
// writes). Without this they interleave into the next test's window and,
// at suite end, race the Mongo disconnect below — the dominant source of
// "single-file green, full-suite flake". The drain is bounded (it resolves
// once the in-flight set empties), so the per-test cost is just the tail of
// writes the test itself triggered.
afterEach(async () => {
  await crowi.drainSideEffects();
});

afterAll(async () => {
  // Drain BEFORE closing the connection so settling writes (render-cache
  // invalidation, backlink/watch/Activity fan-out, notification publish,
  // user-page creation) do not hit a half-closed Mongo/redis client.
  await crowi.drainSideEffects();
  // `teardownForCli` quits redis (the suites leak one live socket each
  // otherwise → parallel handle pressure) then disconnects Mongo.
  await crowi.teardownForCli();
}, 60000);

export const Fixture = {
  async generate(model, fixture) {
    const conn = crowi.getMongo().connection;
    if (conn.readyState === 0) {
      throw new Error();
    }
    const Model = conn.model(model);
    return Promise.all(fixture.map((entity) => new Model(entity).save()));
  },
};
