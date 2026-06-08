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

beforeAll(async () => {
  // Spread process.env FIRST and then layer the test-harness values on
  // top. The original order (`{ ...test, ...process.env }`) silently
  // let an externally-set `MONGO_URI` (e.g. the CI's `mongodb://
  // localhost:27017` from the docker `mongo` service) override the
  // crowi-environment.js per-file db, which collapses every parallel
  // jest worker onto a single shared database and recycles Config
  // documents from previous runs across test files.
  crowi = new Crowi(ROOT_DIR, {
    ...process.env,
    PORT: '13001',
    MONGO_URI: MONGO_URI,
    BASE_URL: 'http://localhost:13001',
    // Public origin (used by getBaseUrl() for CORS + mail links).
    CLIENT_URL: 'http://localhost:13001',
  });
  await crowi.init();

  const honoApp = buildHonoApp(crowi);
  // Wrap `honoApp.fetch` so the `/api/v2` prefix in supertest URLs is
  // stripped before Hono dispatches. Mirrors the rewrite that
  // `crowi/index.ts:start()` applies on the production listener.
  const fetchFn = (request: Request): Response | Promise<Response> => honoApp.fetch(stripApiV2Prefix(request));
  app = getRequestListener(fetchFn);
}, 60000);

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
