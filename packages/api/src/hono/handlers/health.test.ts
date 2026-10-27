import { app } from 'src/test/setup';
import request from 'supertest';
import { createServerLifecycle, type ServerLifecycleCrowi } from '../../util/server-lifecycle';
import { createHonoApp } from '../app';
import { registerHealthRoutes } from './health';

const fakeCrowi = (connected: boolean): ServerLifecycleCrowi & { isMongoConnected: () => boolean } => ({
  collabAttachment: null,
  presenceAttachment: null,
  notificationsAttachment: null,
  drainSideEffects: async () => {},
  isMongoConnected: () => connected,
});

const small = (crowi: ReturnType<typeof fakeCrowi>) => {
  const a = createHonoApp();
  registerHealthRoutes(a, crowi);
  return a;
};

describe('health routes', () => {
  it('AC-1: /healthz is 200 without auth, even with DB down', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');

    const r2 = await small(fakeCrowi(false)).request('/healthz');
    expect(r2.status).toBe(200);
  });

  it('AC-2: /readyz is 200 on the real crowi', async () => {
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('AC-3: /readyz is 503 with only a status key when DB is down', async () => {
    const res = await small(fakeCrowi(false)).request('/readyz');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['status']);
    expect(body.status).toBe('unavailable');
  });

  it('AC-4: after shutdown signal /readyz is 503 and /healthz stays 200', async () => {
    const crowi = fakeCrowi(true);
    const a = small(crowi);
    expect((await a.request('/readyz')).status).toBe(200);
    await createServerLifecycle(crowi, { exit: jest.fn() }).onSignal('SIGTERM');
    expect((await a.request('/readyz')).status).toBe(503);
    expect((await a.request('/healthz')).status).toBe(200);
  });

  it('AC-5: /api prefix works and no X-Request-Id is set', async () => {
    const responses = await Promise.all([
      request(app).get('/healthz'),
      request(app).get('/readyz'),
      request(app).get('/api/healthz'),
      request(app).get('/api/readyz'),
    ]);
    expect(responses[2].status).toBe(responses[0].status);
    expect(responses[2].body).toEqual(responses[0].body);
    expect(responses[3].status).toBe(responses[1].status);
    expect(responses[3].body).toEqual(responses[1].body);
    for (const r of responses) expect(r.headers['x-request-id']).toBeUndefined();
  });

  it('AC-6: probes are absent from the OpenAPI document', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.paths)).not.toContain('/healthz');
    expect(Object.keys(res.body.paths)).not.toContain('/readyz');
  });
});
