/**
 * RFC-0006 Phase 6 Sub-batch D — test harness for the Hono-only api.
 *
 * Express has been removed; the api now boots Hono via
 * `@hono/node-server`'s `createAdaptorServer`. Supertest accepts either a
 * bare Node `RequestListener` `(req, res) => void` OR an already-listening
 * `http.Server` — we build the former with `getRequestListener(fetchFn)`
 * from `@hono/node-server`, then wrap it in the latter (see `app`'s doc
 * comment below for why: feature-test-harness-shared-server).
 *
 * Path rewrite: the OpenAPI contracts register every route at its
 * **unprefixed** path (`/app/info`, `/pages/:id`, ...), and the
 * production server reaches them via the URL rewriter in
 * `crowi/index.ts:start()` that strips a leading `/api`. Tests
 * invariably dial `/api/...`, so we install the same rewrite here
 * — it keeps every existing supertest call site working without
 * change.
 */

import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import faker from 'faker';
import Crowi from 'src/crowi';
import { buildHonoApp } from 'src/hono';
import { stripApiPrefix } from 'src/hono/path-rewrite';

import { bootCrowiWithRetry } from './db-connect-retry';
import { recordDispatchEnd, recordDispatchStart } from './op-ring-buffer';

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
 * Shared `http.Server` for this test FILE, already listening
 * (`beforeAll` awaits `listen(0, '127.0.0.1')` once) by the time any test
 * in the file runs. Backed by the Hono app via `getRequestListener(fetchFn)`
 * wrapped in `createServer(...)` (see `beforeAll` below).
 *
 * feature-test-harness-shared-server: supertest treats a bare
 * `RequestListener` and an already-listening `Server` differently.
 * `Test#serverAddress()` (`supertest/lib/test.js`) checks `app.address()`
 * and, if it's falsy (a plain `RequestListener` has no `.address()` at
 * all — supertest first wraps it in its OWN `http.Server` via
 * `http.createServer(...)`), calls `.listen(0)` itself — a THROWAWAY
 * server + ephemeral port, once per `request(app)` CALL. An
 * already-listening `Server`'s `.address()` is truthy, so that branch is
 * skipped entirely and `.listen()` is never called again. Exporting `app`
 * as the latter turns "one server per request" into "one server per
 * file", with zero call-site changes — `request(app).get('/api/...')`
 * keeps working unmodified everywhere, because supertest accepts both
 * shapes as `app`.
 *
 * This is not a hypothetical: `src/hono/handlers/autocomplete.test.ts` and
 * `page-preview.test.ts` used to each stand up their OWN local
 * `http.Server`, via `createServer(...)` + `.listen(0)`, specifically to
 * route around the per-request-listen behavior above — high-concurrency
 * bursts against it produced a real `connect ETIMEDOUT` flake (see git
 * history for those files). Both local workarounds were removed once
 * `app` here became a shared listening server itself, since standing up a
 * second one on top would just be redundant.
 */
export let app: Server;

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
        // feature-test-harness-shared-server (RC3): without an explicit
        // REDIS_KEY_PREFIX, `util/redis-keyspace.ts` derives the Redis
        // instance slug from CLIENT_URL's hostname alone (`localhost`
        // above) — every parallel jest worker/file would then share the
        // same `crowi:localhost:*` Redis keyspace even though each
        // already gets its own scratch Mongo DB (`MONGO_DB_NAME`, set by
        // `crowi-environment.js`). Reusing that same per-file DB name as
        // the Redis prefix gives Redis the same per-file isolation
        // granularity as Mongo already has, with no new naming scheme: it
        // is already unique per file (worker id + random suffix) and
        // already satisfies the slug format `resolveRedisKeyspace()`
        // requires (`redis-keyspace.ts`'s `SLUG_PATTERN` — alphanumerics
        // plus `._-` only, no `:`). Harmless when `REDIS_URL` is unset
        // (e.g. a dev machine without Redis running): `getEnv()` just
        // never resolves a keyspace from it in that case.
        REDIS_KEY_PREFIX: MONGO_DB_NAME,
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
  // Wrap `honoApp.fetch` so the `/api` prefix in supertest URLs is
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
  //
  // Request-boundary ring buffer (feature-flake-failure-taxonomy AC-2): this
  // is the ONLY place a supertest request reaches Hono, so it is the sole
  // observation point for `op-ring-buffer.ts`'s "was this op dispatched, and
  // with what HTTP status" bookkeeping — see that module's doc comment.
  // Every ring-buffer call is individually wrapped so a bug there can never
  // affect a real request's control flow (start/end recording is best-effort
  // either side of the SAME `try`/`catch` shape the real fetch already had).
  const fetchFn = async (request: Request): Promise<Response> => {
    let opEntry: ReturnType<typeof recordDispatchStart> | null = null;
    try {
      opEntry = recordDispatchStart(request.method, new URL(request.url).pathname);
    } catch {
      // fail-open — see this block's doc comment above.
    }
    try {
      const res = await honoApp.fetch(stripApiPrefix(request));
      if (opEntry) {
        try {
          recordDispatchEnd(opEntry, res.status);
        } catch {
          // fail-open
        }
      }
      if (responseBarrier.enabled) {
        await crowi.drainSideEffects();
      }
      return res;
    } catch (err) {
      if (opEntry) {
        try {
          recordDispatchEnd(opEntry, null);
        } catch {
          // fail-open
        }
      }
      throw err;
    }
  };
  const requestListener = getRequestListener(fetchFn);
  // feature-test-harness-shared-server: wrap the RequestListener in an
  // actually-listening `Server` (see `app`'s doc comment above for why).
  // `listen(0, '127.0.0.1')` picks an OS-assigned ephemeral port — the same
  // thing supertest's own throwaway server used to do per request — just
  // once for this whole FILE instead of once per request.
  const server = createServer(requestListener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  app = server;
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

/**
 * Bound for `afterAll`'s `server.close()` wait, below. superagent — the
 * HTTP client every `request(app)` call resolves through — never keeps
 * connections alive (see `app`'s doc comment / the removed
 * `autocomplete.test.ts` / `page-preview.test.ts` workarounds this file's
 * own doc comments reference), so in practice `close()` settles near-
 * instantly once the last in-flight request finishes. A close that
 * genuinely hangs is the worst failure mode here — it would stall the
 * WHOLE suite, not just this file — so this bound is deliberately short
 * relative to `afterAll`'s own 60000ms hook timeout below: hitting it just
 * warns and lets teardown continue, instead of risking the hook itself
 * timing out (jest's timeout failure is far noisier to diagnose than a
 * `console.warn`).
 */
const SERVER_CLOSE_TIMEOUT_MS = 5000;

/**
 * Awaits `server.close()`, bounded by {@link SERVER_CLOSE_TIMEOUT_MS}.
 * Never rejects: a timeout, or an error the `close()` callback reports
 * (e.g. the server was already stopped), only logs a warning — the
 * `afterAll` below always runs `crowi.teardownForCli()` next regardless
 * (nested `finally`), so throwing here would only add noise, not signal,
 * to that guarantee.
 */
function closeSharedServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[test-harness] setup.ts: shared server.close() did not settle within ${SERVER_CLOSE_TIMEOUT_MS}ms — continuing teardown anyway.`);
      resolve();
    }, SERVER_CLOSE_TIMEOUT_MS);
    // Let jest's own process exit even if this timer is still pending.
    timer.unref();
    server.close((err) => {
      clearTimeout(timer);
      if (err) {
        console.warn(`[test-harness] setup.ts: shared server.close() reported an error — continuing teardown anyway (${err.message}).`);
      }
      resolve();
    });
  });
}

afterAll(async () => {
  // Drain BEFORE closing the connection so settling writes (render-cache
  // invalidation, backlink/watch/Activity fan-out, notification publish,
  // user-page creation) do not hit a half-closed Mongo/redis client.
  await crowi.drainSideEffects();
  try {
    // `app` is only unset here if `beforeAll` itself failed before reaching
    // the `createServer(...)`/`listen()` step above (e.g. `crowi.init()`
    // threw) — guard so that partial-boot failure surfaces as ITSELF in the
    // test report, not masked by an unrelated "server.close is not a
    // function" thrown from this hook (mirrors why `beforeAll` above
    // assigns the module-level `crowi` binding on every attempt: a
    // teardown-time crash must never hide the real boot failure).
    if (app) {
      await closeSharedServer(app);
    }
  } finally {
    // `teardownForCli` quits redis (the suites leak one live socket each
    // otherwise → parallel handle pressure) then disconnects Mongo. Runs
    // regardless of whether the close above succeeded, warned, or was
    // skipped — see this block's structure and `closeSharedServer`'s doc
    // comment.
    await crowi.teardownForCli();
  }
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

/**
 * ASCII-only random username for `Fixture.generate('User', ...)` callers.
 * `faker.internet.userName()` can emit a `.` separator, which the
 * `UsernameSchema` model validator (feature-username-validation-contract)
 * rejects — this generator only emits characters the schema allows.
 */
export const randomUsername = (): string => `user-${faker.random.alphaNumeric(10)}`;

/**
 * Usernames every write boundary must reject, as `[label, value]` rows for
 * `it.each`. Shared by the three request-boundary suites (installer /
 * invite-accept / token-auth register) so adding or removing a rejection
 * case updates one place instead of three files that must be kept in
 * lockstep — a drift that would silently leave one route's suite out of
 * sync with the contract.
 *
 * These verify each route's 400 / `VALIDATION_ERROR` WIRING. The character
 * classes themselves are exhaustively unit-tested against the schema in
 * `packages/api-contract/src/schemas/username.test.ts`; this table exists
 * so no boundary is left unwired, not to re-derive the regex per route.
 */
export const INVALID_USERNAME_CASES: ReadonlyArray<readonly [string, string]> = [
  ['empty string', ''],
  ['whitespace only', '   '],
  ['contains a dot', 'bad.name'],
  ['contains a slash', 'bad/name'],
  ['contains a Unicode character', 'ソタロウ'],
  ['65 characters (one over the boundary)', 'a'.repeat(65)],
];
