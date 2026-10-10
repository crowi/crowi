// @vitest-environment node
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { proxy } from './proxy';

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
