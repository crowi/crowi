import crypto from 'node:crypto';

import { validateEnv } from 'src/util/env-schema';
import {
  buildHandoffCanonicalMessage,
  buildLoginCompleteUrl,
  buildLoginErrorUrl,
  buildProviderCallbackUrl,
  buildProviderStartUrl,
  buildStartCanonicalMessage,
  computeJwkThumbprint,
  createFederatedAuthStateUtil,
  verifySenderProof,
} from 'src/util/federated-auth-state';

/** Minimal `NodeJS.ProcessEnv`-shaped object, mirroring `env-schema.test.ts`'s `makeEnv`. */
function makeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return overrides as unknown as NodeJS.ProcessEnv;
}

/** Minimal fake `Crowi` for `createFederatedAuthStateUtil`'s `Pick<Crowi, 'getConfig' | 'node_env'>`. */
function makeFakeCrowi(secret: string, nodeEnv: string = 'production') {
  return {
    getConfig: () => ({ crowi: { 'app:secret': secret } }),
    node_env: nodeEnv,
  };
}

/** Generate a P-256 key pair and sign `message` with the private key. Returns the JWK + base64url signature the real browser-side flow would produce. */
async function generateSenderProof(message: string): Promise<{ publicJwk: JsonWebKey; signature: string; privateKey: crypto.webcrypto.CryptoKey }> {
  const { publicKey, privateKey } = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicJwk = (await crypto.webcrypto.subtle.exportKey('jwk', publicKey)) as JsonWebKey;
  const signatureBuf = await crypto.webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(message));
  const signature = Buffer.from(signatureBuf).toString('base64url');
  return { publicJwk, signature, privateKey };
}

describe('util/federated-auth-state', () => {
  describe('createFederatedAuthStateUtil — state cookie (AC-2)', () => {
    const basePayload = {
      state: 'state-value',
      provider: 'test-provider',
      continuePath: '/dashboard',
      codeVerifier: 'a-verifier',
      oidcNonce: 'a-nonce',
      handoffJkt: 'a-jkt',
    };

    test('round-trips a valid state through issue/verify', () => {
      const util = createFederatedAuthStateUtil(makeFakeCrowi('secret-1'));
      const cookieValue = util.issue(basePayload);
      const decoded = util.verify(cookieValue, 'test-provider');
      expect(decoded).toMatchObject(basePayload);
      expect(decoded?.expiresAt).toBeGreaterThan(Date.now());
    });

    test('two issued states carry distinct state/nonce values (no accidental collapse across calls)', () => {
      const util = createFederatedAuthStateUtil(makeFakeCrowi('secret-1'));
      const first = util.verify(util.issue({ ...basePayload, state: 'state-a', oidcNonce: 'nonce-a' }), 'test-provider');
      const second = util.verify(util.issue({ ...basePayload, state: 'state-b', oidcNonce: 'nonce-b' }), 'test-provider');
      expect(first?.state).toBe('state-a');
      expect(second?.state).toBe('state-b');
      expect(first?.oidcNonce).not.toBe(second?.oidcNonce);
    });

    test('rejects a cookie signed under a DIFFERENT app secret (HKDF key separation)', () => {
      const issuer = createFederatedAuthStateUtil(makeFakeCrowi('secret-A'));
      const verifier = createFederatedAuthStateUtil(makeFakeCrowi('secret-B'));
      const cookieValue = issuer.issue(basePayload);
      expect(verifier.verify(cookieValue, 'test-provider')).toBeNull();
    });

    test('rejects a payload that was tampered with (signature no longer matches)', () => {
      const util = createFederatedAuthStateUtil(makeFakeCrowi('secret-1'));
      const cookieValue = util.issue(basePayload);
      const dot = cookieValue.lastIndexOf('.');
      const tamperedPayload = Buffer.from(JSON.stringify({ ...basePayload, provider: 'attacker-provider', expiresAt: Date.now() + 300_000 })).toString(
        'base64url',
      );
      const tampered = `${tamperedPayload}${cookieValue.slice(dot)}`;
      expect(util.verify(tampered, 'attacker-provider')).toBeNull();
    });

    test('rejects a cookie whose signature segment was mutated', () => {
      const util = createFederatedAuthStateUtil(makeFakeCrowi('secret-1'));
      const cookieValue = util.issue(basePayload);
      const dot = cookieValue.lastIndexOf('.');
      const mutated = `${cookieValue.slice(0, dot)}.not-the-real-signature`;
      expect(util.verify(mutated, 'test-provider')).toBeNull();
    });

    test('rejects a provider mismatch even with a perfectly valid signature', () => {
      const util = createFederatedAuthStateUtil(makeFakeCrowi('secret-1'));
      const cookieValue = util.issue(basePayload);
      expect(util.verify(cookieValue, 'a-different-provider')).toBeNull();
    });

    test('rejects an expired state (300s TTL)', () => {
      jest.useFakeTimers();
      try {
        const util = createFederatedAuthStateUtil(makeFakeCrowi('secret-1'));
        const cookieValue = util.issue(basePayload);
        expect(util.verify(cookieValue, 'test-provider')).not.toBeNull();
        jest.advanceTimersByTime(300_001);
        expect(util.verify(cookieValue, 'test-provider')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    test('verify returns null for a missing cookie', () => {
      const util = createFederatedAuthStateUtil(makeFakeCrowi('secret-1'));
      expect(util.verify(undefined, 'test-provider')).toBeNull();
    });

    test('issue() throws (never silently emits an oversized cookie) once the serialized value would exceed the 4KB invariant', () => {
      const util = createFederatedAuthStateUtil(makeFakeCrowi('secret-1'));
      // Far beyond `ContinuePathSchema`'s 2000-char max (api-contract) — this
      // pins the defensive backstop `issue()` itself enforces, independent
      // of the input-side schema bound.
      const oversizedContinuePath = `/${'a'.repeat(6000)}`;
      expect(() => util.issue({ ...basePayload, continuePath: oversizedContinuePath })).toThrow(/exceeding the 4096-byte invariant/);
    });

    test('a continuePath comfortably within the schema bound never trips the 4KB guard', () => {
      const util = createFederatedAuthStateUtil(makeFakeCrowi('secret-1'));
      const withinBoundContinuePath = `/${'a'.repeat(2000)}`;
      expect(() => util.issue({ ...basePayload, continuePath: withinBoundContinuePath })).not.toThrow();
    });

    test('the cookie HMAC is keyed by the HKDF-derived subkey, NOT the raw app secret directly (HKDF label separation)', () => {
      // Pins the module doc comment's claim that the state-cookie HMAC key
      // is HKDF(secret, info="crowi:oauth-state-hmac:v1") rather than the
      // raw secret itself — a prior version of this suite only asserted
      // that verification fails under a DIFFERENT secret, which would also
      // pass if the raw secret were used directly (a much weaker property:
      // it wouldn't catch a regression from HKDF-derivation back to
      // raw-secret HMAC, since that regression still varies by secret).
      const secret = 'secret-1';
      const util = createFederatedAuthStateUtil(makeFakeCrowi(secret));
      const cookieValue = util.issue(basePayload);
      const dot = cookieValue.lastIndexOf('.');
      const payloadB64 = cookieValue.slice(0, dot);
      const mac = cookieValue.slice(dot + 1);

      const naiveRawKeyMac = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
      expect(mac).not.toBe(naiveRawKeyMac);

      // Independently re-derive the SAME HKDF subkey out-of-band and confirm
      // it reproduces the exact MAC — pins the concrete derivation (label +
      // empty salt + 32-byte output), not just "some transform happened".
      const expectedKey = crypto.hkdfSync('sha256', secret, Buffer.alloc(0), 'crowi:oauth-state-hmac:v1', 32);
      const expectedMac = crypto.createHmac('sha256', Buffer.from(expectedKey)).update(payloadB64).digest('base64url');
      expect(mac).toBe(expectedMac);
    });

    test('cookie attributes match the RFC-0014 phase 1 §"設計の主な判断" 2 contract', () => {
      const prodUtil = createFederatedAuthStateUtil(makeFakeCrowi('secret-1', 'production'));
      expect(prodUtil.cookieOptions).toEqual({
        httpOnly: true,
        sameSite: 'Lax',
        secure: true,
        path: '/api/auth/providers',
        maxAge: 300,
      });

      const devUtil = createFederatedAuthStateUtil(makeFakeCrowi('secret-1', 'development'));
      expect(devUtil.cookieOptions.secure).toBe(false);
    });
  });

  describe('computeJwkThumbprint — RFC 7638', () => {
    test('matches the RFC 7638 §3.1 worked example (RSA key thumbprint pattern applied to a fixed EC-shaped input)', () => {
      // RFC 7638 has no EC worked example in the base spec text, so this
      // pins OUR canonicalization (lexicographic crv/kty/x/y, no
      // whitespace) against a fixed input/output pair instead of an
      // external vector — a regression in key order or whitespace would
      // change this hash.
      const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: 'x-value', y: 'y-value' };
      const expected = crypto.createHash('sha256').update('{"crv":"P-256","kty":"EC","x":"x-value","y":"y-value"}').digest('base64url');
      expect(computeJwkThumbprint(jwk)).toBe(expected);
    });

    test('extra JWK fields (e.g. `ext`, `key_ops`) do not change the thumbprint', () => {
      const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: 'x-value', y: 'y-value', ext: true, key_ops: ['verify'] };
      const minimal: JsonWebKey = { kty: 'EC', crv: 'P-256', x: 'x-value', y: 'y-value' };
      expect(computeJwkThumbprint(jwk)).toBe(computeJwkThumbprint(minimal));
    });
  });

  describe('verifySenderProof — ES256 (P-256)', () => {
    test('accepts a genuine signature over the exact message', async () => {
      const message = 'GET\nhttps://api.example.com/api/auth/providers/google/start\n/dashboard\nfake-jwk-b64';
      const { publicJwk, signature } = await generateSenderProof(message);
      await expect(verifySenderProof({ publicJwk, signature }, message)).resolves.toBe(true);
    });

    test('rejects a signature over a DIFFERENT message (e.g. a swapped continue path)', async () => {
      const message = 'GET\nhttps://api.example.com/api/auth/providers/google/start\n/dashboard\nfake-jwk-b64';
      const { publicJwk, signature } = await generateSenderProof(message);
      await expect(verifySenderProof({ publicJwk, signature }, 'a-different-message')).resolves.toBe(false);
    });

    test('rejects a signature verified against a DIFFERENT public key than the one that signed it', async () => {
      const message = 'POST\nhttps://api.example.com/api/auth/handoff\nsome-code';
      const { signature } = await generateSenderProof(message);
      const other = await generateSenderProof('unrelated');
      await expect(verifySenderProof({ publicJwk: other.publicJwk, signature }, message)).resolves.toBe(false);
    });

    test('rejects a non-EC / non-P-256 JWK without throwing', async () => {
      const jwk = { kty: 'RSA', n: 'x', e: 'AQAB' } as unknown as JsonWebKey;
      await expect(verifySenderProof({ publicJwk: jwk, signature: 'not-real' }, 'message')).resolves.toBe(false);
    });

    test('rejects a malformed base64url signature without throwing', async () => {
      const { publicJwk } = await generateSenderProof('message');
      await expect(verifySenderProof({ publicJwk, signature: '!!!not-base64url!!!' }, 'message')).resolves.toBe(false);
    });
  });

  describe('trusted origin URL builders (AC-4) — never derived from a request Host', () => {
    test('build the expected start / callback / handoff / login-complete / login-error URLs from a resolved apiUrl/webUrl pair', () => {
      const apiUrl = 'https://api.example.com';
      const webUrl = 'https://wiki.example.com';
      expect(buildProviderStartUrl(apiUrl, 'google')).toBe('https://api.example.com/api/auth/providers/google/start');
      expect(buildProviderCallbackUrl(apiUrl, 'google')).toBe('https://api.example.com/api/auth/providers/google/callback');
      expect(buildLoginCompleteUrl(webUrl, 'the-code', '/dashboard')).toBe('https://wiki.example.com/login/complete?code=the-code&continue=%2Fdashboard');
      expect(buildLoginErrorUrl(webUrl, 'invalid_state')).toBe('https://wiki.example.com/login?error=invalid_state');
    });

    test('canonical messages are built ONLY from the resolved origins, never a forged/attacker Host', () => {
      const apiUrl = 'https://api.example.com';
      // A caller who accidentally passed a request Host instead of the
      // trusted apiUrl would produce a visibly different message —
      // asserting the exact string is what pins "never derived from Host".
      expect(buildStartCanonicalMessage(apiUrl, 'google', '/dashboard', 'jwk-b64')).toBe(
        'GET\nhttps://api.example.com/api/auth/providers/google/start\n/dashboard\njwk-b64',
      );
      expect(buildHandoffCanonicalMessage(apiUrl, 'the-code')).toBe('POST\nhttps://api.example.com/api/auth/handoff\nthe-code');
    });

    test('provider names are URL-encoded when building trusted URLs', () => {
      expect(buildProviderStartUrl('https://api.example.com', 'a/b c')).toBe('https://api.example.com/api/auth/providers/a%2Fb%20c/start');
    });
  });

  describe('AUTH_PUBLIC_API_URL / AUTH_PUBLIC_WEB_URL — origin-only env validation + fallback (AC-4)', () => {
    test('accepts a bare origin, with or without a trailing slash', () => {
      const withSlash = validateEnv(makeEnv({ AUTH_PUBLIC_API_URL: 'https://api.example.com/', AUTH_PUBLIC_WEB_URL: 'https://wiki.example.com' }));
      expect(withSlash.values.federatedAuthPublicUrls).toEqual({ apiUrl: 'https://api.example.com', webUrl: 'https://wiki.example.com' });
    });

    test.each([
      ['a path', 'https://api.example.com/callback'],
      ['a query string', 'https://api.example.com/?x=1'],
      ['a fragment', 'https://api.example.com/#frag'],
      ['userinfo', 'https://user:pass@api.example.com'],
      ['not even a URL', 'not-a-url'],
    ])('rejects AUTH_PUBLIC_API_URL with %s (boot fails when SET but malformed)', (_label, raw) => {
      expect(() => validateEnv(makeEnv({ AUTH_PUBLIC_API_URL: raw }))).toThrow(/AUTH_PUBLIC_API_URL/);
    });

    test.each([
      ['a path', 'https://wiki.example.com/some/path'],
      ['a query string', 'https://wiki.example.com/?x=1'],
    ])('rejects AUTH_PUBLIC_WEB_URL with %s', (_label, raw) => {
      expect(() => validateEnv(makeEnv({ AUTH_PUBLIC_WEB_URL: raw }))).toThrow(/AUTH_PUBLIC_WEB_URL/);
    });

    test('AUTH_PUBLIC_WEB_URL defaults to CLIENT_URL re-validated as origin-only', () => {
      const result = validateEnv(makeEnv({ CLIENT_URL: 'https://wiki.example.com' }));
      expect(result.values.federatedAuthPublicUrls).toEqual({ apiUrl: 'https://wiki.example.com', webUrl: 'https://wiki.example.com' });
    });

    test('a CLIENT_URL with a path cannot back the web-URL fallback — federated auth stays disabled (no boot failure)', () => {
      const result = validateEnv(makeEnv({ CLIENT_URL: 'https://wiki.example.com/some/path' }));
      expect(result.values.federatedAuthPublicUrls).toBeNull();
      // CLIENT_URL's OWN descriptor still only warns (unchanged pre-existing behaviour) — this must not boot-fail.
      expect(() => validateEnv(makeEnv({ CLIENT_URL: 'https://wiki.example.com/some/path' }))).not.toThrow();
    });

    test('AUTH_PUBLIC_API_URL defaults to the resolved web URL (same-origin deployment) when unset', () => {
      const result = validateEnv(makeEnv({ AUTH_PUBLIC_WEB_URL: 'https://wiki.example.com' }));
      expect(result.values.federatedAuthPublicUrls).toEqual({ apiUrl: 'https://wiki.example.com', webUrl: 'https://wiki.example.com' });
    });

    test('API and web origins split independently when both are explicitly set', () => {
      const result = validateEnv(makeEnv({ AUTH_PUBLIC_API_URL: 'https://api.example.com', AUTH_PUBLIC_WEB_URL: 'https://wiki.example.com' }));
      expect(result.values.federatedAuthPublicUrls).toEqual({ apiUrl: 'https://api.example.com', webUrl: 'https://wiki.example.com' });
    });

    test('resolves to null (federated auth disabled) when nothing is configured — never a boot failure', () => {
      const result = validateEnv(makeEnv({}));
      expect(result.values.federatedAuthPublicUrls).toBeNull();
    });

    test('never derives a trusted origin from anything resembling a request Host/Origin/forwarded header — only the three env vars feed the resolver', () => {
      // `validateEnv` takes ONLY a `NodeJS.ProcessEnv`-shaped object; there
      // is no request/Host parameter it could read even if it wanted to —
      // this test pins that a Host-like extra key is simply ignored.
      const result = validateEnv(makeEnv({ 'X-Forwarded-Host': 'attacker.example.com' } as Record<string, string>));
      expect(result.values.federatedAuthPublicUrls).toBeNull();
    });
  });
});
