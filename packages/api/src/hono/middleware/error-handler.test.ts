/**
 * RFC-0025 §9 Phase 2 — structured logging for the global Hono `onError`
 * handler.
 *
 * `LOG_LEVEL` is fixed to `info` for this whole file at module top level
 * (before `src/test/setup.ts`'s registered `beforeAll` runs — see that
 * file's own doc comment) so the response-start record (level `info`) is
 * admitted; `packages/api/src/test/logging-env.ts` otherwise fixes the
 * `server` Jest project's floor to `error`. Restored in `afterAll` so a
 * later file reusing this Jest worker observes the project default again,
 * not whatever this file leaves in `process.env`.
 */
const ORIGINAL_LOG_LEVEL = process.env.LOG_LEVEL;
process.env.LOG_LEVEL = 'info';

import { Hono } from 'hono';
import { requestId } from 'hono/request-id';

import type { LogRecord } from 'src/util/logger';
import * as sink from 'src/util/logger-sink';

import { honoOnError } from './error-handler';
import { createRequestScope, REQUEST_ID_HEADER } from './request-scope';

afterAll(() => {
  if (ORIGINAL_LOG_LEVEL === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = ORIGINAL_LOG_LEVEL;
  }
});

const localRequestId = () => requestId({ headerName: REQUEST_ID_HEADER, limitLength: 128 });

/**
 * Minimal app carrying the same request-ID + request-scope + `onError`
 * wiring `buildHonoApp` installs in production (`hono/index.ts`), without
 * any of the unrelated route families — this file tests only the
 * error-boundary logging contract.
 */
const buildApp = (errorHandler: typeof honoOnError = honoOnError) => {
  const app = new Hono();
  app.use('*', localRequestId());
  app.use('*', createRequestScope());
  app.onError(errorHandler);
  app.get('/boom', () => {
    throw new Error('handler exploded: contains a secret-looking value');
  });
  return app;
};

describe('honoOnError structured logging', () => {
  let records: LogRecord[];
  let writeSpy: jest.SpiedFunction<typeof sink.write>;

  beforeEach(() => {
    // `restoreMocks: true` (jest.config.js `server` project) auto-restores
    // this after EVERY test — re-installing per test (not once in
    // `beforeAll`) is what keeps every case's capture isolated and never
    // falls through to the real memoized sink (which would print NDJSON to
    // the worker's stdout, per this file's own header comment).
    records = [];
    writeSpy = jest.spyOn(sink, 'write').mockImplementation((record) => {
      records.push(record);
    });
  });

  it('orders one correlated Hono error record before one 500 response-start record', async () => {
    const app = buildApp();
    const res = await app.request('/boom');

    expect(res.status).toBe(500);
    expect(records).toHaveLength(2);
    const [errorRecord, responseStartRecord] = records;
    expect(errorRecord.namespace).toBe('crowi:hono:onError');
    expect(errorRecord.level).toBe('error');
    expect(responseStartRecord.namespace).toBe('crowi:hono:request');
    expect(responseStartRecord.level).toBe('info');
    expect(responseStartRecord.data).toMatchObject({ status: 500 });
    expect(errorRecord.requestId).toBeDefined();
    expect(responseStartRecord.requestId).toBe(errorRecord.requestId);
  });

  it('records the original Error without exposing its details in the HTTP body', async () => {
    const app = buildApp();
    const res = await app.request('/boom');
    const body = await res.json();

    const [errorRecord] = records;
    expect(errorRecord.message).toBe('unhandled error in Hono handler');
    expect(errorRecord.data?.error).toBeInstanceOf(Error);
    expect((errorRecord.data?.error as Error).message).toBe('handler exploded: contains a secret-looking value');

    expect(body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(JSON.stringify(body)).not.toContain('secret-looking');
  });

  it('preserves the generic INTERNAL_ERROR status body and nosniff header', async () => {
    const app = buildApp();
    const res = await app.request('/boom');
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('preserves the generic 500 when the structured sink write throws', async () => {
    writeSpy.mockImplementation(() => {
      throw new Error('sink write boom');
    });
    const app = buildApp();

    const res = await app.request('/boom');
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('does not re-enter honoOnError when the logger sink fails', async () => {
    // Only the FIRST write (the onError error record) fails — proving a
    // failure there does not stop the SECOND write (the response-start
    // record) from being attempted, i.e. `honoOnError` itself ran exactly
    // once rather than being invoked again to report the logging failure.
    writeSpy.mockImplementationOnce(() => {
      throw new Error('sink write boom');
    });
    // Wrapping the real handler in a `jest.fn` and asserting its own call
    // count directly checks "global handler invocation is one" by its
    // stated subject, rather than inferring it from `writeSpy`'s call count.
    const onErrorSpy = jest.fn(honoOnError);
    const app = buildApp(onErrorSpy);

    const res = await app.request('/boom');

    expect(res.status).toBe(500);
    expect(onErrorSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledTimes(2);
    // The first (error-record) call threw and was never pushed; the
    // second (response-start) call succeeded normally.
    expect(records).toHaveLength(1);
    expect(records[0].namespace).toBe('crowi:hono:request');
  });
});
