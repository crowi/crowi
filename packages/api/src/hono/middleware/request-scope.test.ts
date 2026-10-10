/**
 * RFC-0025 §9 Phase 2 — Hono request-scope middleware.
 *
 * `LOG_LEVEL` is fixed to `info` for this whole file at module top level
 * (before `src/test/setup.ts`'s registered `beforeAll` runs — see that
 * file's own doc comment) so response-start records (level `info`) are
 * admitted; `packages/api/src/test/logging-env.ts` otherwise fixes the
 * `server` Jest project's floor to `error`. Restored in `afterAll` so a
 * later file reusing this Jest worker observes the project default again.
 * One case below separately re-floors to `warn` inside an isolated module
 * registry so it does not disturb the rest of this file's `info` floor.
 */
const ORIGINAL_LOG_LEVEL = process.env.LOG_LEVEL;
process.env.LOG_LEVEL = 'info';

import type { CrowiPlugin } from '@crowi/plugin-api';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { Context, Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { buildHonoApp } from 'src/hono';
import { app, crowi, Fixture } from 'src/test/setup';
import { createLogger, type LogRecord } from 'src/util/logger';
import * as sink from 'src/util/logger-sink';
import { getRequestScope } from 'src/util/request-scope';
import request from 'supertest';

import { createCors } from './cors';
import { honoOnError } from './error-handler';
import { createRequestScope, REQUEST_ID_HEADER } from './request-scope';
import { createSecurityHeaders } from './security-headers';

const localRequestId = () => requestId({ headerName: REQUEST_ID_HEADER, limitLength: 128 });

/**
 * `src/test/setup.ts`'s `beforeAll` swaps `global.Response` for
 * `@hono/node-server`'s adaptor shim before any test body runs — captured
 * here at module top so later cases can assert the shim is actually
 * installed for their case, instead of assuming it.
 */
const NativeResponse = globalThis.Response;

afterAll(() => {
  if (ORIGINAL_LOG_LEVEL === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = ORIGINAL_LOG_LEVEL;
  }
});

// The harness boots Crowi with `BASE_URL=http://localhost:13001`
// (`src/test/setup.ts`), so this is the canonical allow-listed CORS
// origin, same as `cors.test.ts`.
const BASE_ORIGIN = 'http://localhost:13001';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Minimal app: canonical request ID + request scope only, no auth/DB. */
const buildBasicApp = () => {
  const basicApp = new Hono();
  basicApp.use('*', localRequestId());
  basicApp.use('*', createRequestScope());
  basicApp.onError(honoOnError);
  return basicApp;
};

/**
 * Mirrors production layering (`hono/index.ts`'s middleware install order)
 * minus plugin / route-family registration, which the RESPONSE-CLASS-MATRIX
 * and raw-response / streaming cases don't need.
 */
const buildProdOrderApp = () => {
  const prodOrderApp = new Hono();
  prodOrderApp.use('*', localRequestId());
  prodOrderApp.use('*', createRequestScope());
  prodOrderApp.use('*', createSecurityHeaders());
  prodOrderApp.use('*', createCors(crowi));
  prodOrderApp.onError(honoOnError);
  return prodOrderApp;
};

/**
 * Ingredients `deriveRouteTemplate`'s route-derivation algorithm actually
 * has to disambiguate: an OpenAPI route with a param validator (duplicate
 * method+path entries), an exact-path middleware mount ahead of a
 * concrete method handler (admin prefix), an exact-path `ALL` mount with
 * no further concrete handler for some methods (`/search`), and a
 * concrete `.all()` route (`/mcp`).
 */
const buildRouteMatrixApp = () => {
  const matrixApp = new OpenAPIHono();
  matrixApp.use('*', localRequestId());
  matrixApp.use('*', createRequestScope());
  matrixApp.use('*', createCors(crowi));
  matrixApp.onError(honoOnError);

  const pageRoute = createRoute({
    method: 'get',
    path: '/pages/{id}',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: 'ok', content: { 'application/json': { schema: z.object({ id: z.string() }) } } },
    },
  });
  matrixApp.openapi(pageRoute, (c) => c.json({ id: c.req.valid('param').id }));

  matrixApp.use('/admin/*', async (c, next) => {
    await next();
  });
  matrixApp.post('/admin/users', (c) => c.json({ ok: true }));

  // Exact-path `ALL` mount (`registerSearchRoutes`'s real shape) — no
  // trailing `*`, so a method-mismatch dispatch falls through to
  // `deriveRouteTemplate`'s step 3 (the RT-08 deliberate residual below)
  // instead of `<unmatched>`.
  matrixApp.use('/search', async (c, next) => {
    await next();
  });
  matrixApp.get('/search', (c) => c.json({ results: [] }));

  matrixApp.all('/mcp', (c) => c.json({ jsonrpc: '2.0', result: {} }));

  return matrixApp;
};

/** Builds a throwaway `buildHonoApp(crowi)` whose loaded-plugin list is stubbed to `[plugin]`, restoring the spy immediately after the build (plugins are captured inside the built app's closures — `plugin-router-smoke.test.ts`'s own pattern). */
const buildAppWithPlugin = (plugin: CrowiPlugin): ReturnType<typeof buildHonoApp> => {
  const manager = crowi.pluginManager;
  if (!manager) throw new Error('PluginManager not bootstrapped in harness');
  const spy = jest.spyOn(manager, 'getLoadedPlugins').mockReturnValue([plugin]);
  try {
    return buildHonoApp(crowi);
  } finally {
    spy.mockRestore();
  }
};

describe('request-scope middleware', () => {
  let records: LogRecord[];

  beforeEach(() => {
    // Reinstalled per test (not once in `beforeAll`) — `restoreMocks: true`
    // (jest.config.js `server` project) auto-restores a `jest.spyOn`
    // after every test, so a `beforeAll`-installed spy would call through
    // to the real memoized sink from the second test onward and print
    // NDJSON to the worker's stdout instead of being captured.
    records = [];
    jest.spyOn(sink, 'write').mockImplementation((record) => {
      records.push(record);
    });
  });

  it('preserves a valid safe-token ID across context ALS record and response', async () => {
    const basicApp = buildBasicApp();
    basicApp.get('/probe', (c) => c.json({ ctxId: c.get('requestId'), alsId: getRequestScope()?.requestId }));

    const sentId = 'abc-123_ABC=';
    const res = await basicApp.request('/probe', { headers: { [REQUEST_ID_HEADER]: sentId } });
    const body = (await res.json()) as { ctxId: string; alsId: string };

    expect(res.headers.get(REQUEST_ID_HEADER.toLowerCase())).toBe(sentId);
    expect(body.ctxId).toBe(sentId);
    expect(body.alsId).toBe(sentId);
    const responseStart = records.find((r) => r.namespace === 'crowi:hono:request');
    expect(responseStart?.requestId).toBe(sentId);
  });

  it('generates one canonical UUID for each missing or empty request ID', async () => {
    const basicApp = buildBasicApp();
    basicApp.get('/probe', (c) => c.json({ ctxId: c.get('requestId') }));

    const cases: Array<Record<string, string>> = [{}, { [REQUEST_ID_HEADER]: '' }];
    const seen = new Set<string>();
    for (const headers of cases) {
      const res = await basicApp.request('/probe', { headers });
      const body = (await res.json()) as { ctxId: string };
      const headerId = res.headers.get(REQUEST_ID_HEADER.toLowerCase());
      expect(headerId).toMatch(UUID_RE);
      expect(body.ctxId).toBe(headerId);
      seen.add(headerId as string);
    }
    expect(seen.size).toBe(cases.length);

    const responseStarts = records.filter((r) => r.namespace === 'crowi:hono:request');
    expect(responseStarts).toHaveLength(cases.length);
    for (const record of responseStarts) {
      expect(seen.has(record.requestId ?? '')).toBe(true);
    }
  });

  it('accepts 128 safe characters and regenerates 129', async () => {
    const basicApp = buildBasicApp();
    basicApp.get('/probe', (c) => c.json({ ctxId: c.get('requestId') }));

    const id128 = 'a'.repeat(128);
    const res128 = await basicApp.request('/probe', { headers: { [REQUEST_ID_HEADER]: id128 } });
    expect(res128.headers.get(REQUEST_ID_HEADER.toLowerCase())).toBe(id128);

    const id129 = 'a'.repeat(129);
    const res129 = await basicApp.request('/probe', { headers: { [REQUEST_ID_HEADER]: id129 } });
    const header129 = res129.headers.get(REQUEST_ID_HEADER.toLowerCase());
    expect(header129).not.toBe(id129);
    expect(header129).toMatch(UUID_RE);
  });

  it('regenerates a newline-shadowed ID across context response and record', async () => {
    // A real `Request`/`Headers` rejects a newline-bearing header value at
    // construction time, before Hono ever sees it — so this exercises the
    // grammar check with a fixture middleware that shadows `c.req.header`
    // for this one header name, installed BEFORE `requestId()`.
    const shadowApp = new Hono();
    shadowApp.use('*', async (c, next) => {
      const original = c.req.header.bind(c.req);
      Object.defineProperty(c.req, 'header', {
        configurable: true,
        value: (name: string) => (name.toLowerCase() === REQUEST_ID_HEADER.toLowerCase() ? 'evil\nvalue' : original(name)),
      });
      await next();
    });
    shadowApp.use('*', localRequestId());
    shadowApp.use('*', createRequestScope());
    shadowApp.get('/probe', (c) => c.json({ ctxId: c.get('requestId') }));

    const res = await shadowApp.request('/probe');
    const body = (await res.json()) as { ctxId: string };
    const headerId = res.headers.get(REQUEST_ID_HEADER.toLowerCase());

    expect(headerId).toMatch(UUID_RE);
    expect(headerId).not.toContain('evil');
    expect(body.ctxId).toBe(headerId);
    const responseStart = records.find((r) => r.namespace === 'crowi:hono:request');
    expect(responseStart?.requestId).toBe(headerId);
  });

  it('regenerates whitespace slash and Unicode request IDs', async () => {
    const basicApp = buildBasicApp();
    basicApp.get('/probe', (c) => c.json({ ctxId: c.get('requestId') }));

    // A genuinely non-Latin1 value (e.g. Japanese) cannot be sent as a raw
    // `Headers` value at all (the Fetch spec requires header values to be
    // ByteStrings) — 'wörld-héllo' stays within Latin1 while still failing
    // Hono's `/^[\w\-=]+$/` grammar via the accented characters.
    for (const invalid of ['has space', 'has/slash', 'wörld-héllo']) {
      const res = await basicApp.request('/probe', { headers: { [REQUEST_ID_HEADER]: invalid } });
      const headerId = res.headers.get(REQUEST_ID_HEADER.toLowerCase());
      expect(headerId).toMatch(UUID_RE);
      expect(headerId).not.toBe(invalid);
    }
  });

  it('emits the fixed response-start record from final dispatch state', async () => {
    const basicApp = buildBasicApp();
    basicApp.get('/widgets/:id', (c) => c.json({ id: c.req.param('id') }, 201));

    const res = await basicApp.request('/widgets/42');
    expect(res.status).toBe(201);

    const responseStart = records.find((r) => r.namespace === 'crowi:hono:request');
    expect(responseStart?.level).toBe('info');
    expect(responseStart?.message).toBe('response started');
    expect(responseStart?.data).toEqual({ method: 'GET', route: '/widgets/:id', status: 201, durationMs: expect.any(Number) });
  });

  it('clamps a negative observed clock delta to zero', async () => {
    let call = 0;
    jest.spyOn(globalThis.performance, 'now').mockImplementation(() => {
      call += 1;
      return call === 1 ? 1000 : 500; // end < start
    });

    const basicApp = buildBasicApp();
    basicApp.get('/probe', (c) => c.json({ ok: true }));
    const res = await basicApp.request('/probe');

    expect(res.status).toBe(200);
    const responseStart = records.find((r) => r.namespace === 'crowi:hono:request');
    expect(responseStart?.data).toMatchObject({ durationMs: 0 });
  });

  it('emits the fixed correlated diagnostic for a non-Error escape', async () => {
    const basicApp = buildBasicApp();
    const thrown = { marker: 'not-an-error' };
    basicApp.get('/reject', () => {
      throw thrown;
    });

    await expect(basicApp.request('/reject')).rejects.toBe(thrown);

    const errorRecord = records.find((r) => r.namespace === 'crowi:hono:request' && r.level === 'error');
    expect(errorRecord?.message).toBe('non-Error value escaped Hono dispatch');
    expect(errorRecord?.data?.error).toBe(thrown);
    expect(errorRecord?.data?.outcome).toBe('non-error-throw-rethrown');
  });

  it('rethrows a non-Error by identity without Hono response artifacts', async () => {
    const basicApp = buildBasicApp();
    const thrown = 'plain-string-throw';
    basicApp.get('/reject', () => {
      throw thrown;
    });

    let caught: unknown;
    try {
      await basicApp.request('/reject');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(thrown);
    const responseStart = records.find((r) => r.namespace === 'crowi:hono:request' && r.level === 'info');
    expect(responseStart).toBeUndefined();
  });

  it('isolates two barrier-interleaved request IDs before and after awaits', async () => {
    const basicApp = buildBasicApp();
    const gateA = createDeferred<void>();
    const gateB = createDeferred<void>();
    const observed: Record<'a' | 'b', string[]> = { a: [], b: [] };

    basicApp.get('/slow/:tag', async (c) => {
      const tag = c.req.param('tag') as 'a' | 'b';
      observed[tag].push(getRequestScope()?.requestId ?? 'none');
      await (tag === 'a' ? gateA.promise : gateB.promise);
      observed[tag].push(getRequestScope()?.requestId ?? 'none');
      return c.json({ tag });
    });

    const reqA = basicApp.request('/slow/a', { headers: { [REQUEST_ID_HEADER]: 'request-a' } });
    const reqB = basicApp.request('/slow/b', { headers: { [REQUEST_ID_HEADER]: 'request-b' } });

    await new Promise((r) => setTimeout(r, 0));
    gateA.resolve();
    await new Promise((r) => setTimeout(r, 0));
    gateB.resolve();

    await Promise.all([reqA, reqB]);

    expect(observed.a).toEqual(['request-a', 'request-a']);
    expect(observed.b).toEqual(['request-b', 'request-b']);

    // The AC is about records, not just handler-side ALS reads: the two
    // response-start records this interleaved pair produced must each
    // carry the request ID of the dispatch that produced them.
    const responseStartIds = records
      .filter((r) => r.namespace === 'crowi:hono:request' && r.level === 'info')
      .map((r) => r.requestId)
      .sort();
    expect(responseStartIds).toEqual(['request-a', 'request-b']);
  });

  it('omits requestId from a record emitted after overlapping requests settle', async () => {
    const basicApp = buildBasicApp();
    basicApp.get('/quick/:tag', (c) => c.json({ tag: c.req.param('tag') }));

    await Promise.all([
      basicApp.request('/quick/a', { headers: { [REQUEST_ID_HEADER]: 'settle-a' } }),
      basicApp.request('/quick/b', { headers: { [REQUEST_ID_HEADER]: 'settle-b' } }),
    ]);

    const outsideLogger = createLogger('crowi:hono:request-scope-test');
    outsideLogger.info('after both requests settle');

    const settledRecord = records.find((r) => r.message === 'after both requests settle');
    expect(settledRecord?.requestId).toBeUndefined();
  });

  it('keeps response-start metadata on the fixed privacy allowlist', async () => {
    const basicApp = buildBasicApp();
    basicApp.get('/users/:id', (c) => c.json({ id: c.req.param('id') }));

    const res = await basicApp.request('/users/42?secret=shh', { headers: { Authorization: 'Bearer top-secret' } });
    expect(res.status).toBe(200);

    const responseStart = records.find((r) => r.namespace === 'crowi:hono:request');
    expect(Object.keys(responseStart?.data ?? {}).sort()).toEqual(['durationMs', 'method', 'route', 'status']);
    // `durationMs` is excluded from the substring check below: it is a
    // legitimate numeric metric, not user-controlled input, and its
    // unconstrained floating-point digits can coincidentally contain "42"
    // (the path-param value under test) with no privacy implication.
    const { durationMs: _durationMs, ...userFacingFields } = responseStart?.data ?? {};
    const serialized = JSON.stringify(userFacingFields);
    expect(serialized).not.toContain('42');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('top-secret');
  });

  it('keeps Hono context ALS record and response header on one canonical ID', async () => {
    const basicApp = buildBasicApp();
    basicApp.get('/probe', (c) => c.json({ ctxId: c.get('requestId'), alsId: getRequestScope()?.requestId }));

    const res = await basicApp.request('/probe', { headers: { [REQUEST_ID_HEADER]: 'canonical-id-1' } });
    const body = (await res.json()) as { ctxId: string; alsId: string };
    const headerId = res.headers.get(REQUEST_ID_HEADER.toLowerCase());
    const responseStart = records.find((r) => r.namespace === 'crowi:hono:request');

    expect(new Set([body.ctxId, body.alsId, headerId, responseStart?.requestId])).toEqual(new Set(['canonical-id-1']));
  });

  it('never records path parameter query or raw unmatched target as route', async () => {
    const basicApp = buildBasicApp();
    basicApp.get('/pages/:id', (c) => c.json({ id: c.req.param('id') }));

    const matched = await basicApp.request('/pages/abc123?secret=shh');
    expect(matched.status).toBe(200);
    const unmatched = await basicApp.request('/no/such/path?other=1');
    expect(unmatched.status).toBe(404);

    const routes = records.filter((r) => r.namespace === 'crowi:hono:request').map((r) => r.data?.route);
    expect(routes).toContain('/pages/:id');
    expect(routes).toContain('<unmatched>');
    for (const route of routes) {
      expect(String(route)).not.toContain('abc123');
      expect(String(route)).not.toContain('secret');
      expect(String(route)).not.toContain('/no/such/path');
    }
  });

  it('warns without reading or mutating response state when dispatch returns unfinalized', async () => {
    const unfinalizedApp = new Hono();
    unfinalizedApp.use('*', localRequestId());

    let resGetterSpy: jest.SpiedFunction<() => Response> | undefined;
    let headerSpy: jest.SpiedFunction<Context['header']> | undefined;
    // `mockRestore()` clears `mock.calls` as a side effect, so the call
    // count must be captured before it runs — asserting on the spy itself
    // afterwards would vacuously pass regardless of whether `c.res` was read.
    let resGetterCallCountAfterDispatch = -1;
    // Installed between `requestId()` and `createRequestScope()`, so the
    // window it brackets is exactly the request-scope callback: requestId's
    // own pre-dispatch `c.header()` staging already ran, and Hono's later
    // "Context is not finalized" -> `honoOnError` conversion (§10 step 6)
    // happens after this middleware's own `await next()` returns.
    unfinalizedApp.use('*', async (c, next) => {
      resGetterSpy = jest.spyOn(Context.prototype, 'res', 'get');
      headerSpy = jest.spyOn(c, 'header');
      await next();
      resGetterCallCountAfterDispatch = resGetterSpy.mock.calls.length;
      resGetterSpy.mockRestore();
    });
    unfinalizedApp.use('*', createRequestScope());
    unfinalizedApp.onError(honoOnError);
    // No `return` — the dispatch resolves without ever finalizing `c`.
    unfinalizedApp.get('/void', async () => {
      /* intentionally returns nothing */
    });

    const sentId = 'unfinalized-warn-request-id';
    const res = await unfinalizedApp.request('/void', { headers: { [REQUEST_ID_HEADER]: sentId } });

    expect(res.status).toBe(500); // Hono's own not-finalized -> honoOnError conversion, outside this middleware's window.
    expect(resGetterCallCountAfterDispatch).toBe(0);
    expect(headerSpy).not.toHaveBeenCalled();

    const warnRecord = records.find((r) => r.namespace === 'crowi:hono:request' && r.level === 'warn');
    expect(warnRecord?.message).toBe('dispatch returned no response');
    expect(warnRecord?.data).toEqual({ method: 'GET', route: '/void' });
    expect(warnRecord?.requestId).toBe(sentId);

    const responseStart = records.find((r) => r.namespace === 'crowi:hono:request' && r.level === 'info');
    expect(responseStart).toBeUndefined();

    // Hono's own not-finalized 500 conversion runs after compose resolved,
    // outside the ALS continuation — its record carries no request ID.
    const errorRecord = records.find((r) => r.namespace === 'crowi:hono:onError');
    expect(errorRecord?.requestId).toBeUndefined();
  });

  it('correlates outer 200 and inner 403 records for an MCP tool dispatch', async () => {
    const User = crowi.model('User');
    const email = 'request-scope-mcp-correlation@example.com';
    const [user] = await Fixture.generate('User', [{ name: 'Request Scope MCP Tester', username: 'requestScopeMcpTester', email }]);
    user.status = User.STATUS_ACTIVE;
    await user.save();

    const PersonalAccessToken = crowi.model('PersonalAccessToken');
    const { token, tokenHash } = PersonalAccessToken.generateToken();
    await PersonalAccessToken.create({ tokenHash, userId: user._id, name: 'request-scope-mcp-readonly', scopes: ['pages:read'] });

    try {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'crowi_create_page', arguments: { path: '/request-scope-mcp-correlation-test/should-fail', body: '# nope' } },
        });

      expect(res.status).toBe(200);
      // Makes the test-plan's "after fully consuming the text/event-stream
      // body" precondition explicit rather than implicit in supertest's
      // buffering: this assertion only passes once `res.text` holds the
      // complete SSE frame carrying the inner dispatch's 403 mapping.
      expect(res.text).toContain('INSUFFICIENT_SCOPE');

      const responseStarts = records.filter((r) => r.namespace === 'crowi:hono:request' && r.level === 'info');
      const outer = responseStarts.find((r) => r.data?.route === '/mcp');
      const inner = responseStarts.find((r) => r.data?.route === '/pages');

      expect(outer?.data).toMatchObject({ status: 200 });
      expect(inner?.data).toMatchObject({ status: 403 });
      expect(outer?.requestId).toBeDefined();
      expect(inner?.requestId).toBe(outer?.requestId);
    } finally {
      await crowi.model('User').deleteMany({ email });
    }
  });

  it('suppresses the info response-start record at warn floor without changing the response', async () => {
    const savedLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'warn';
    try {
      await jest.isolateModulesAsync(async () => {
        const isolatedRecords: LogRecord[] = [];
        jest.doMock('src/util/logger-sink', () => ({
          write: (record: LogRecord) => {
            isolatedRecords.push(record);
          },
          writeFatal: () => {
            throw new Error('writeFatal is unused by this case');
          },
        }));
        // A separate module registry is required for `LOG_LEVEL=warn` to
        // resolve fresh: this file's own top-level `info` assignment has
        // already memoized the shared registry's floor.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Hono: IsolatedHono } = require('hono') as typeof import('hono');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const isolatedRequestScope = require('./request-scope') as typeof import('./request-scope');

        const isolatedApp = new IsolatedHono();
        // Only `createRequestScope` needs the isolated registry's freshly
        // resolved `LOG_LEVEL=warn` floor — `requestId()` itself has no
        // dependency on that floor, so the file-level `localRequestId`
        // helper (built from the normally-imported `hono/request-id`) is
        // reused here rather than requiring it a second time.
        isolatedApp.use('*', localRequestId());
        isolatedApp.use('*', isolatedRequestScope.createRequestScope());
        isolatedApp.get('/probe', (c) => c.json({ ok: true }));

        const sentId = 'warn-floor-request-id';
        const res = await isolatedApp.request('/probe', { headers: { [isolatedRequestScope.REQUEST_ID_HEADER]: sentId } });
        const body = (await res.json()) as { ok: boolean };

        expect(res.status).toBe(200);
        expect(body).toEqual({ ok: true });
        expect(res.headers.get(isolatedRequestScope.REQUEST_ID_HEADER.toLowerCase())).toBe(sentId);
        expect(isolatedRecords.filter((r) => r.namespace === 'crowi:hono:request')).toHaveLength(0);
      });
    } finally {
      if (savedLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = savedLevel;
    }
  });

  it('preserves a handler-constructed raw Response under the adaptor Response shim', async () => {
    // `src/test/setup.ts`'s `beforeAll` has already called `getRequestListener`
    // for this file — `global.Response` is process-wide the adaptor shim by
    // the time this test body runs, not the native class. Asserted directly (rather
    // than assumed) so a harness change that silently reverted to native
    // `Response` would fail loudly here instead of passing vacuously.
    expect(globalThis.Response).not.toBe(NativeResponse);
    const prodOrderApp = buildProdOrderApp();
    const bodyText = 'hello-raw-body';
    prodOrderApp.get(
      '/raw',
      () =>
        new Response(bodyText, {
          status: 200,
          headers: [
            ['Content-Type', 'text/plain'],
            ['Content-Length', String(Buffer.byteLength(bodyText))],
            ['Set-Cookie', 'a=1'],
            ['Set-Cookie', 'b=2'],
          ],
        }),
    );

    const res = await prodOrderApp.request('/raw');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(bodyText);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(bodyText)));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get(REQUEST_ID_HEADER.toLowerCase())).toBeTruthy();
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  });

  it('returns under the adaptor Response shim before a gated streaming source drains', async () => {
    // Same F-9 precondition as the raw-response case above — asserted
    // directly instead of assumed.
    expect(globalThis.Response).not.toBe(NativeResponse);
    const prodOrderApp = buildProdOrderApp();
    const gate = createDeferred<void>();
    let pulled = 0;
    const bodyText = 'first-chunksecond-chunk';
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulled += 1;
        if (pulled === 1) {
          controller.enqueue(new TextEncoder().encode('first-chunk'));
          return;
        }
        await gate.promise;
        controller.enqueue(new TextEncoder().encode('second-chunk'));
        controller.close();
      },
    });
    prodOrderApp.get(
      '/stream',
      () =>
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/plain', 'Content-Length': String(Buffer.byteLength(bodyText)) },
        }),
    );

    const res = await prodOrderApp.request('/stream');

    // A `ReadableStream` eagerly pulls its FIRST chunk to fill the default
    // highWaterMark=1 queue as soon as it is constructed, independent of any
    // consumer — so `pulled` is already 1 by the time dispatch returns. The
    // SECOND pull (gated behind `gate.promise`, required to produce the rest
    // of `bodyText`) only happens once something actually reads the body;
    // dispatch resolving without that second pull having run is exactly the
    // "returns before the gated source drains" contract this case checks.
    expect(pulled).toBe(1);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(bodyText)));
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get(REQUEST_ID_HEADER.toLowerCase())).toBeTruthy();

    gate.resolve();
    expect(await res.text()).toBe(bodyText);
  });

  it('installs the production request boundary outside CORS and later route registrations', async () => {
    const honoApp = buildHonoApp(crowi);

    const ordinary = await honoApp.request('/app/info');
    expect(ordinary.status).toBe(200);
    expect(ordinary.headers.get(REQUEST_ID_HEADER.toLowerCase())).toBeTruthy();

    const preflight = await honoApp.request('/app/info', {
      method: 'OPTIONS',
      headers: { Origin: BASE_ORIGIN, 'Access-Control-Request-Method': 'GET' },
    });
    expect([200, 204]).toContain(preflight.status);
    expect(preflight.headers.get(REQUEST_ID_HEADER.toLowerCase())).toBeTruthy();

    const mcpUnauthenticated = await honoApp.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(mcpUnauthenticated.status).toBe(401);
    expect(mcpUnauthenticated.headers.get(REQUEST_ID_HEADER.toLowerCase())).toBeTruthy();

    const plugin: CrowiPlugin = {
      name: 'assembly-fixture',
      version: '0.0.0',
      registerRoutes: (scope) => {
        scope.route('GET', '/ping', (c) => c.json({ pong: true }), { auth: 'public' });
      },
    };
    const pluginApp = buildAppWithPlugin(plugin);
    const pluginRes = await pluginApp.request('/plugins/assembly-fixture/ping');
    expect(pluginRes.status).toBe(200);
    expect(pluginRes.headers.get(REQUEST_ID_HEADER.toLowerCase())).toBeTruthy();

    const responseStarts = records.filter((r) => r.namespace === 'crowi:hono:request' && r.level === 'info');
    expect(responseStarts.map((r) => r.data?.route)).toEqual(['/app/info', '<preflight>', '/mcp', '/plugins/assembly-fixture/ping']);
  });

  describe('ROUTE-MATRIX', () => {
    it('derives every ROUTE-MATRIX row from matched route templates', async () => {
      const matrixApp = buildRouteMatrixApp();

      const rt01 = await matrixApp.request('/pages/42');
      expect(rt01.status).toBe(200);

      const rt02 = await matrixApp.request('/pages/42', {
        method: 'OPTIONS',
        headers: { Origin: BASE_ORIGIN, 'Access-Control-Request-Method': 'GET' },
      });
      expect([200, 204]).toContain(rt02.status);

      const rt03 = await matrixApp.request('/nope/whatever');
      expect(rt03.status).toBe(404);

      const rt04 = await matrixApp.request('/nope', {
        method: 'OPTIONS',
        headers: { Origin: BASE_ORIGIN, 'Access-Control-Request-Method': 'GET' },
      });
      expect([200, 204]).toContain(rt04.status);

      const rt05 = await matrixApp.request('/admin/users', { method: 'POST' });
      expect(rt05.status).toBe(200);

      const rt06 = await matrixApp.request('/mcp', { method: 'POST' });
      expect(rt06.status).toBe(200);

      const rt08 = await matrixApp.request('/search', { method: 'DELETE' });
      expect(rt08.status).toBe(404);

      const rt09 = await matrixApp.request('/pages/42', { method: 'HEAD' });
      expect(rt09.status).toBe(200);

      const plugin: CrowiPlugin = {
        name: 'fixture',
        version: '0.0.0',
        registerRoutes: (scope) => {
          scope.route('GET', '/hook', (c) => c.json({ ok: true }), { auth: 'public' });
        },
      };
      const pluginApp = buildAppWithPlugin(plugin);
      const rt07 = await pluginApp.request('/plugins/fixture/hook');
      expect(rt07.status).toBe(200);

      const responseStarts = records.filter((r) => r.namespace === 'crowi:hono:request');
      expect(responseStarts.map((r) => r.data?.route)).toEqual([
        '/pages/:id', // RT-01
        '<preflight>', // RT-02
        '<unmatched>', // RT-03
        '<preflight>', // RT-04
        '/admin/users', // RT-05
        '/mcp', // RT-06
        '/search', // RT-08 — deliberate residual, see `deriveRouteTemplate`
        '/pages/:id', // RT-09 — HEAD dispatched against the matching GET route
        '/plugins/fixture/hook', // RT-07
      ]);
    });
  });

  describe('RESPONSE-CLASS-MATRIX', () => {
    it('covers every RESPONSE-CLASS-MATRIX row with one response-start record', async () => {
      const prodOrderApp = buildProdOrderApp();
      prodOrderApp.get('/ok', (c) => c.json({ ok: true }));
      prodOrderApp.get('/raw', () => new Response('raw-body', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
      prodOrderApp.get('/boom', () => {
        throw new Error('response-class-matrix boom');
      });

      const preflight = await prodOrderApp.request('/ok', {
        method: 'OPTIONS',
        headers: { Origin: BASE_ORIGIN, 'Access-Control-Request-Method': 'GET' },
      });
      expect([200, 204]).toContain(preflight.status);
      expect(preflight.headers.get(REQUEST_ID_HEADER.toLowerCase())).toBeTruthy();

      const notFound = await prodOrderApp.request('/does-not-exist');
      expect(notFound.status).toBe(404);
      expect(notFound.headers.get(REQUEST_ID_HEADER.toLowerCase())).toBeTruthy();

      const ordinary = await prodOrderApp.request('/ok');
      expect(ordinary.status).toBe(200);
      expect(ordinary.headers.get(REQUEST_ID_HEADER.toLowerCase())).toBeTruthy();

      const raw = await prodOrderApp.request('/raw');
      expect(raw.status).toBe(200);
      expect(await raw.text()).toBe('raw-body');
      expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
      expect(raw.headers.get(REQUEST_ID_HEADER.toLowerCase())).toBeTruthy();

      const errored = await prodOrderApp.request('/boom');
      expect(errored.status).toBe(500);
      expect(errored.headers.get('x-content-type-options')).toBe('nosniff');
      expect(errored.headers.get(REQUEST_ID_HEADER.toLowerCase())).toBeTruthy();

      const responseStarts = records.filter((r) => r.namespace === 'crowi:hono:request' && r.level === 'info');
      expect(responseStarts).toHaveLength(5);
    });
  });
});
