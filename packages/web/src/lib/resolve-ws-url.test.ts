import { describe, it, expect, afterEach, vi } from 'vitest';

// feature-web-cross-origin-runtime-env: the resolver now reads NEXT_PUBLIC_*
// via next-runtime-env's runtime `env()` (our `./runtime-env` wrapper). Mock it
// to read live from `process.env` so the existing `process.env`-based
// arrangement still drives every precedence branch — the resolution logic under
// test is identical, only the read source moved from build-time inline to a
// runtime lookup.
vi.mock('./runtime-env', () => ({
  env: (key: string) => process.env[key],
}));

import { resolveWsUrl } from './resolve-ws-url';

/**
 * feature-web-image-runtime-config: the WS URL resolver backs all three
 * realtime namespaces (`/collab`, `/presence`, `/notifications`). Resolution
 * order under test:
 *   1. NEXT_PUBLIC_COLLAB_URL explicit override
 *   2. NEXT_PUBLIC_API_URL (cross-origin / dev / Vercel)
 *   3. dev (NODE_ENV==='development') → http://localhost:4301 (api dev port)
 *   4. window.location (same-origin distributed image, prod)
 *   5. http://localhost:4301 (SSR / nothing configured)
 */
describe('resolveWsUrl', () => {
  const originalCollab = process.env.NEXT_PUBLIC_COLLAB_URL;
  const originalApi = process.env.NEXT_PUBLIC_API_URL;

  afterEach(() => {
    if (originalCollab === undefined) delete process.env.NEXT_PUBLIC_COLLAB_URL;
    else process.env.NEXT_PUBLIC_COLLAB_URL = originalCollab;
    if (originalApi === undefined) delete process.env.NEXT_PUBLIC_API_URL;
    else process.env.NEXT_PUBLIC_API_URL = originalApi;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe('dev (NODE_ENV=development) dials the api port, not window.location', () => {
    it('returns localhost:4301 when no env is set, even though window is :3000', () => {
      // Regression: in `pnpm dev` web is :4302 and the WS api is :4301; the
      // Next dev server cannot proxy the WS upgrade, so falling through to
      // window.location (:4302/:3000) would target a port with no WS server.
      vi.stubEnv('NODE_ENV', 'development');
      delete process.env.NEXT_PUBLIC_COLLAB_URL;
      delete process.env.NEXT_PUBLIC_API_URL;
      expect(resolveWsUrl('notifications')).toBe('ws://localhost:4301/notifications');
      expect(resolveWsUrl('collab')).toBe('ws://localhost:4301/collab');
    });
  });

  describe('window.location default (same-origin image, production)', () => {
    it('derives from window.location when no env is set', () => {
      // jsdom serves the suite from http://localhost:3000.
      vi.stubEnv('NODE_ENV', 'production');
      delete process.env.NEXT_PUBLIC_COLLAB_URL;
      delete process.env.NEXT_PUBLIC_API_URL;
      expect(resolveWsUrl('collab')).toBe('ws://localhost:3000/collab');
      expect(resolveWsUrl('presence')).toBe('ws://localhost:3000/presence');
      expect(resolveWsUrl('notifications')).toBe('ws://localhost:3000/notifications');
    });

    it('maps https origin to wss', () => {
      vi.stubEnv('NODE_ENV', 'production');
      delete process.env.NEXT_PUBLIC_COLLAB_URL;
      delete process.env.NEXT_PUBLIC_API_URL;
      vi.stubGlobal('window', {
        location: { protocol: 'https:', host: 'wiki.example.com' },
      });
      expect(resolveWsUrl('collab')).toBe('wss://wiki.example.com/collab');
    });
  });

  describe('NEXT_PUBLIC_API_URL (dev / Vercel) takes precedence over window.location', () => {
    it('uses the api URL as-is even though window exists', () => {
      delete process.env.NEXT_PUBLIC_COLLAB_URL;
      process.env.NEXT_PUBLIC_API_URL = 'http://localhost:4301';
      expect(resolveWsUrl('collab')).toBe('ws://localhost:4301/collab');
    });

    it('maps https api URL to wss', () => {
      delete process.env.NEXT_PUBLIC_COLLAB_URL;
      process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com';
      expect(resolveWsUrl('presence')).toBe('wss://api.example.com/presence');
    });

    it('strips a trailing slash so the URL is never `//<namespace>`', () => {
      delete process.env.NEXT_PUBLIC_COLLAB_URL;
      process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com/';
      expect(resolveWsUrl('notifications')).toBe('wss://api.example.com/notifications');
    });
  });

  describe('NEXT_PUBLIC_COLLAB_URL explicit override wins', () => {
    it('beats both NEXT_PUBLIC_API_URL and window.location', () => {
      process.env.NEXT_PUBLIC_COLLAB_URL = 'wss://collab.example.com';
      process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com';
      expect(resolveWsUrl('collab')).toBe('wss://collab.example.com/collab');
    });

    it('strips a doubled namespace suffix so one override env serves all three', () => {
      process.env.NEXT_PUBLIC_COLLAB_URL = 'wss://collab.example.com/collab';
      expect(resolveWsUrl('presence')).toBe('wss://collab.example.com/presence');

      process.env.NEXT_PUBLIC_COLLAB_URL = 'wss://collab.example.com/notifications/';
      expect(resolveWsUrl('notifications')).toBe('wss://collab.example.com/notifications');
    });
  });

  describe('SSR fallback', () => {
    it('falls back to localhost:4301 when window is undefined and no env is set', () => {
      delete process.env.NEXT_PUBLIC_COLLAB_URL;
      delete process.env.NEXT_PUBLIC_API_URL;
      vi.stubGlobal('window', undefined);
      expect(resolveWsUrl('collab')).toBe('ws://localhost:4301/collab');
    });
  });
});
