// @vitest-environment node
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { describe, expect, it, vi } from 'vitest';
import { config, proxy } from './proxy';

const call = async (headers: Record<string, string>) => {
  const res = await proxy(new NextRequest('http://localhost/admin', { headers }));
  return res;
};
const forwarded = (res: Response) => res.headers.get('x-middleware-request-x-paraglide-locale');

describe('proxy locale resolution', () => {
  it('uses Accept-Language and sets the cookie when none exists', async () => {
    const res = await call({ 'accept-language': 'en-US,en' });
    expect(forwarded(res)).toBe('en');
    expect(res.headers.get('set-cookie')).toContain('PARAGLIDE_LOCALE=en');
  });

  it('keeps the cookie locale regardless of Accept-Language and does not re-set it', async () => {
    const res = await call({ cookie: 'PARAGLIDE_LOCALE=ja', 'accept-language': 'en-US,en' });
    expect(forwarded(res)).toBe('ja');
    expect(res.headers.get('set-cookie') ?? '').not.toContain('PARAGLIDE_LOCALE');
  });

  it('falls back to baseLocale when Accept-Language has no supported language', async () => {
    const res = await call({ 'accept-language': 'fr-FR' });
    expect(forwarded(res)).toBe('ja');
  });
});

describe('proxy framing denial', () => {
  const at = (path: string) => proxy(new NextRequest(`http://localhost${path}`));
  const denied = (res: Response) => res.headers.get('content-security-policy') === "frame-ancestors 'none'" && res.headers.get('x-frame-options') === 'DENY';
  const untouched = (res: Response) => res.headers.get('content-security-policy') === null && res.headers.get('x-frame-options') === null;

  const DENIED = [
    '/',
    '/admin/security',
    '/login',
    '/_edit',
    '/_history',
    '/some/wiki/page',
    '/_ARTIFACT-FRAME',
    '/_Artifact-Frame/',
    '/API',
    '/Api/x',
    '/files',
    '/files/x',
    '/.well-known',
    '/.well-known/foo',
    '/apiary',
    '/_artifact-frame/nested',
    '/_artifact-frame-lookalike',
    '/logo-guide',
    '/images/wiki',
    '/favicon.ico/wiki',
    '/_next/static/x',
    '/_next/image',
  ];
  const EXEMPT = ['/api', '/api/x', '/_artifact-frame', '/_artifact-frame/'];

  it.each(DENIED)('denies framing on %s', async (path) => {
    expect(denied(await at(path))).toBe(true);
  });

  it.each(EXEMPT)('leaves %s to its own framing policy', async (path) => {
    expect(untouched(await at(path))).toBe(true);
  });

  it('decides on the pathname only, not the query', async () => {
    expect(untouched(await at('/api/x?a=/b'))).toBe(true);
    expect(denied(await at('/page?next=/api/x'))).toBe(true);
  });

  it.each([...DENIED, ...EXEMPT])('the real matcher runs the proxy on %s', (path) => {
    expect(unstable_doesMiddlewareMatch({ config, url: `http://localhost${path}` })).toBe(true);
  });

  it('keeps the locale cookie and forwarded header alongside the framing headers', async () => {
    const res = await proxy(new NextRequest('http://localhost/admin', { headers: { 'accept-language': 'en' } }));
    expect(denied(res)).toBe(true);
    expect(forwarded(res)).toBe('en');
    expect(res.headers.get('set-cookie')).toContain('PARAGLIDE_LOCALE=en');
  });
});

describe('proxy framing denial when paraglide short-circuits', () => {
  it('applies the headers to a response the callback never produced', async () => {
    vi.resetModules();
    vi.doMock('@paraglide/server.js', () => ({
      paraglideMiddleware: async () => new Response(null, { status: 307, headers: { location: '/elsewhere' } }),
    }));
    try {
      const { proxy: shortCircuited } = await import('./proxy');
      const res = await shortCircuited(new NextRequest('http://localhost/page'));
      expect(res.status).toBe(307);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    } finally {
      vi.doUnmock('@paraglide/server.js');
      vi.resetModules();
    }
  });
});
