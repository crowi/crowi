import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServerLifecycle, isServerDraining, type ServerLifecycleCrowi } from './server-lifecycle';

type FakeAttachment = { shutdown: jest.Mock<Promise<void>, []> };

const makeCrowi = (overrides: Partial<ServerLifecycleCrowi> = {}): ServerLifecycleCrowi => ({
  collabAttachment: null,
  presenceAttachment: null,
  notificationsAttachment: null,
  drainSideEffects: async () => {},
  ...overrides,
});

const attachment = (impl: () => Promise<void> = async () => {}): FakeAttachment => ({ shutdown: jest.fn(impl) });

const servers: http.Server[] = [];

async function startServer(handler: http.RequestListener): Promise<{ server: http.Server; port: number; received: Promise<void> }> {
  let markReceived!: () => void;
  const received = new Promise<void>((resolve) => {
    markReceived = resolve;
  });
  const server = http.createServer((req, res) => {
    markReceived();
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { server, port: (server.address() as AddressInfo).port, received };
}

function get(port: number, agent: http.Agent | false): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
      let body = '';
      res.on('data', (d) => {
        body += d;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

describe('createServerLifecycle', () => {
  it('AC-7: in-flight request completes, new connections are refused', async () => {
    const { server, port, received } = await startServer((_req, res) => {
      setTimeout(() => res.end('done'), 100);
    });
    const exit = jest.fn();
    const lc = createServerLifecycle(makeCrowi(), { exit, graceMs: 2000 });
    lc.attach(server);

    const inflight = get(port, false);
    await received;
    const signalled = lc.onSignal('SIGTERM');
    await expect(get(port, false)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await expect(inflight).resolves.toEqual({ status: 200, body: 'done' });
    await signalled;
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('AC-8: draining and closed before attachments shut down; exit after them', async () => {
    const { server } = await startServer((_req, res) => res.end());
    const exit = jest.fn();
    const seen: Array<{ draining: boolean; listening: boolean }> = [];
    const crowi = makeCrowi();
    let finished = 0;
    const mk = () =>
      attachment(async () => {
        seen.push({ draining: isServerDraining(crowi), listening: server.listening });
        await new Promise((r) => setTimeout(r, 20));
        finished++;
      });
    Object.assign(crowi, { collabAttachment: mk(), presenceAttachment: mk(), notificationsAttachment: mk() });
    exit.mockImplementation(() => {
      expect(finished).toBe(3);
    });
    const lc = createServerLifecycle(crowi, { exit, graceMs: 2000 });
    lc.attach(server);
    await lc.onSignal('SIGTERM');
    expect(seen).toHaveLength(3);
    expect(seen.every((s) => s.draining && !s.listening)).toBe(true);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('AC-9: busy keep-alive connection is closed right after its response, without forced close', async () => {
    const { server, port, received } = await startServer((_req, res) => {
      setTimeout(() => res.end('ok'), 200);
    });
    const closeAll = jest.spyOn(server, 'closeAllConnections');
    const agent = new http.Agent({ keepAlive: true });
    const exit = jest.fn();
    const lc = createServerLifecycle(makeCrowi(), { exit, graceMs: 3000 });
    lc.attach(server);

    let socketClosed!: Promise<void>;
    const result = new Promise<{ status: number | undefined }>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode }));
      });
      req.on('socket', (sock) => {
        socketClosed = new Promise<void>((r) => sock.once('close', () => r()));
      });
      req.on('error', reject);
    });
    await received;
    const signalled = lc.onSignal('SIGTERM');
    await expect(result).resolves.toEqual({ status: 200 });
    await socketClosed;
    await signalled;
    agent.destroy();
    expect(closeAll).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('AC-10: hung request is cut at the deadline and side effects are not awaited', async () => {
    const { server, port, received } = await startServer(() => {});
    const drainSideEffects = jest.fn(async () => {});
    const exit = jest.fn();
    const lc = createServerLifecycle(makeCrowi({ drainSideEffects }), { exit, graceMs: 300 });
    lc.attach(server);

    const hung = get(port, false);
    const hungAssertion = expect(hung).rejects.toMatchObject({ message: expect.stringMatching(/ECONNRESET|socket hang up/) });
    await received;
    await lc.onSignal('SIGTERM');
    await hungAssertion;
    expect(exit).toHaveBeenCalledWith(0);
    expect(drainSideEffects).not.toHaveBeenCalled();
  });

  it('AC-11: second signal is ignored', async () => {
    const { server } = await startServer((_req, res) => res.end());
    const a = attachment();
    const b = attachment();
    const c = attachment();
    const exit = jest.fn();
    const lc = createServerLifecycle(makeCrowi({ collabAttachment: a, presenceAttachment: b, notificationsAttachment: c } as never), { exit, graceMs: 1000 });
    lc.attach(server);
    await Promise.all([lc.onSignal('SIGTERM'), lc.onSignal('SIGINT')]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    for (const x of [a, b, c]) expect(x.shutdown).toHaveBeenCalledTimes(1);
  });

  it('AC-12: signal before attach exits, and a later attached server stops listening', async () => {
    const { server } = await startServer((_req, res) => res.end());
    const exit = jest.fn();
    const lc = createServerLifecycle(makeCrowi(), { exit, graceMs: 1000 });
    await lc.onSignal('SIGTERM');
    expect(exit).toHaveBeenCalledWith(0);
    lc.attach(server);
    expect(server.listening).toBe(false);
  });

  describe('AC-15: side effects', () => {
    it('exit waits for drainSideEffects', async () => {
      const { server } = await startServer((_req, res) => res.end());
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const exit = jest.fn();
      const lc = createServerLifecycle(makeCrowi({ drainSideEffects: () => gate }), { exit, graceMs: 5000 });
      lc.attach(server);
      const signalled = lc.onSignal('SIGTERM');
      await new Promise((r) => setTimeout(r, 150));
      expect(exit).not.toHaveBeenCalled();
      release();
      await signalled;
      expect(exit).toHaveBeenCalledWith(0);
    });

    it('exit happens at the deadline when side effects never settle', async () => {
      const { server } = await startServer((_req, res) => res.end());
      const exit = jest.fn();
      const lc = createServerLifecycle(makeCrowi({ drainSideEffects: () => new Promise<void>(() => {}) }), { exit, graceMs: 300 });
      lc.attach(server);
      await lc.onSignal('SIGTERM');
      expect(exit).toHaveBeenCalledWith(0);
    });
  });
});
