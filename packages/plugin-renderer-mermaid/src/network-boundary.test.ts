/**
 * Negative test for spec §10's production deny-by-default network
 * boundary: after installing it, every one of the named vectors must
 * fail when invoked (not merely "wasn't called") — a mechanical
 * assertion that the boundary itself, not just Phase 0's spike
 * instrumentation, blocks outbound I/O.
 *
 * Runs as a plain (CJS) Jest test — `network-boundary.ts` only touches
 * Node core builtins (`node:net`/`http`/`https`/`dns`/`tls`) via
 * `createRequire`, so unlike `render-worker.ts` (which needs `jsdom` +
 * `mermaid`, both ESM-only leaves) this module needs none of the
 * fork()-a-real-process workaround Phase 0 documents.
 */
import * as http from 'node:http';
import * as net from 'node:net';
import { _resetDenyByDefaultNetworkBoundaryForTest, installDenyByDefaultNetworkBoundary } from './network-boundary';

describe('installDenyByDefaultNetworkBoundary', () => {
  beforeEach(() => {
    _resetDenyByDefaultNetworkBoundaryForTest();
    installDenyByDefaultNetworkBoundary();
  });

  // Leaves `net`/`http`/`https`/`dns`/`tls` unpatched for any other test
  // file that happens to share this Jest worker process.
  afterAll(() => {
    _resetDenyByDefaultNetworkBoundaryForTest();
  });

  it('fetch() throws instead of attempting a connection', async () => {
    expect(() => (globalThis as unknown as { fetch: (...a: unknown[]) => unknown }).fetch('https://example.invalid')).toThrow(/deny-by-default/);
  });

  it('new XMLHttpRequest() throws instead of constructing a usable client', () => {
    const XHR = (globalThis as unknown as { XMLHttpRequest: new () => unknown }).XMLHttpRequest;
    expect(() => new XHR()).toThrow(/deny-by-default/);
  });

  it('new WebSocket(...) throws instead of opening a connection', () => {
    const WS = (globalThis as unknown as { WebSocket: new (url: string) => unknown }).WebSocket;
    expect(() => new WS('wss://example.invalid')).toThrow(/deny-by-default/);
  });

  it('new EventSource(...) throws instead of opening a connection', () => {
    const ES = (globalThis as unknown as { EventSource: new (url: string) => unknown }).EventSource;
    expect(() => new ES('https://example.invalid')).toThrow(/deny-by-default/);
  });

  it('net.connect(...) throws instead of attempting a socket connection', () => {
    expect(() => net.connect(80, 'example.invalid')).toThrow(/deny-by-default/);
  });

  it('net.createConnection(...) throws', () => {
    expect(() => net.createConnection(80, 'example.invalid')).toThrow(/deny-by-default/);
  });

  it('new net.Socket().connect(...) throws', () => {
    const socket = new net.Socket();
    expect(() => socket.connect(80, 'example.invalid')).toThrow(/deny-by-default/);
  });

  it('http.request(...) throws instead of issuing a request', () => {
    expect(() => http.request('http://example.invalid')).toThrow(/deny-by-default/);
  });

  it('http.get(...) throws', () => {
    expect(() => http.get('http://example.invalid')).toThrow(/deny-by-default/);
  });

  it('https.request(...) / https.get(...) throw', async () => {
    const https = await import('node:https');
    expect(() => https.request('https://example.invalid')).toThrow(/deny-by-default/);
    expect(() => https.get('https://example.invalid')).toThrow(/deny-by-default/);
  });

  it('tls.connect(...) throws', async () => {
    const tls = await import('node:tls');
    expect(() => tls.connect(443, 'example.invalid')).toThrow(/deny-by-default/);
  });

  it('dns.lookup(...) fails via its callback rather than resolving a hostname', async () => {
    const dns = await import('node:dns');
    const err = await new Promise<Error | null>((resolve) => {
      dns.lookup('example.invalid', (e) => resolve(e ?? null));
    });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/deny-by-default/);
  });

  it('dns.resolve(...) fails via its callback', async () => {
    const dns = await import('node:dns');
    const err = await new Promise<Error | null>((resolve) => {
      dns.resolve('example.invalid', (e) => resolve(e ?? null));
    });
    expect(err).toBeInstanceOf(Error);
  });

  it('dns.resolveAny(...) fails via its callback (round-3 review gap)', async () => {
    const dns = await import('node:dns');
    const err = await new Promise<Error | null>((resolve) => {
      dns.resolveAny('example.invalid', (e) => resolve(e ?? null));
    });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/deny-by-default/);
  });

  it('dns.promises.lookup(...) rejects instead of resolving a hostname (round-3 review gap)', async () => {
    const dns = await import('node:dns');
    await expect(dns.promises.lookup('example.invalid')).rejects.toThrow(/deny-by-default/);
  });

  it('dns.promises.resolve(...) / dns.promises.resolve4(...) / dns.promises.resolveAny(...) all reject', async () => {
    const dns = await import('node:dns');
    await expect(dns.promises.resolve('example.invalid')).rejects.toThrow(/deny-by-default/);
    await expect(dns.promises.resolve4('example.invalid')).rejects.toThrow(/deny-by-default/);
    await expect(dns.promises.resolveAny('example.invalid')).rejects.toThrow(/deny-by-default/);
  });

  it("node:dns/promises' lookup(...) rejects too — same object as dns.promises.lookup", async () => {
    const dnsPromises = await import('node:dns/promises');
    await expect(dnsPromises.lookup('example.invalid')).rejects.toThrow(/deny-by-default/);
  });

  it('new dns.Resolver().resolve4(...) fails via its callback (Resolver instances carry their own methods)', async () => {
    const dns = await import('node:dns');
    const resolver = new dns.Resolver();
    const err = await new Promise<Error | null>((resolve) => {
      resolver.resolve4('example.invalid', (e) => resolve(e ?? null));
    });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/deny-by-default/);
  });

  it('new dns.promises.Resolver().resolve4(...) rejects too', async () => {
    const dns = await import('node:dns');
    const resolver = new dns.promises.Resolver();
    await expect(resolver.resolve4('example.invalid')).rejects.toThrow(/deny-by-default/);
  });

  it('is idempotent — calling install twice does not throw or double-wrap', () => {
    expect(() => installDenyByDefaultNetworkBoundary()).not.toThrow();
    expect(() => net.connect(80, 'example.invalid')).toThrow(/deny-by-default/);
  });
});
