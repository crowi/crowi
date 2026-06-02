import { join, resolve } from 'node:path';
import Crowi from 'src/crowi';

/**
 * Regression for the boot reporter mislabelling the api row with the web port.
 *
 * `getBaseUrl()` returns `CLIENT_URL` (= `app:url`, the public site origin,
 * which in dev is the web app on :4302). The api `🚀 ready` banner / the
 * `@@crowi:ready api <url>` marker must instead report the address the api is
 * actually listening on (`this.port`, default 4301). `getApiReadyUrl()`
 * isolates that decision; here we lock it to `this.port` even when
 * `getBaseUrl()` points elsewhere.
 *
 * Constructing `Crowi` is side-effect-free (no DB), so this runs without the
 * MongoMemoryServer harness.
 */

const ROOT_DIR = resolve(join(__dirname, '..', '..'));

describe('Crowi.getApiReadyUrl', () => {
  it('uses this.port, not getBaseUrl()', () => {
    const crowi = new Crowi(ROOT_DIR, {
      PORT: '4301',
      // getBaseUrl() would return this (= the web app origin in dev).
      CLIENT_URL: 'http://localhost:4302',
    } as unknown as NodeJS.ProcessEnv);

    expect(crowi.getBaseUrl()).toBe('http://localhost:4302');
    expect(crowi.getApiReadyUrl()).toBe('http://localhost:4301');
  });

  it('tracks a custom PORT', () => {
    const crowi = new Crowi(ROOT_DIR, {
      PORT: '9999',
      CLIENT_URL: 'http://localhost:4302',
    } as unknown as NodeJS.ProcessEnv);

    expect(crowi.getApiReadyUrl()).toBe('http://localhost:9999');
  });

  it('defaults to 4301 when PORT is unset', () => {
    const crowi = new Crowi(ROOT_DIR, {} as unknown as NodeJS.ProcessEnv);
    expect(crowi.getApiReadyUrl()).toBe('http://localhost:4301');
  });
});
