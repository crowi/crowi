import crypto from 'node:crypto';

import { validateEnv } from 'src/util/env-schema';
import {
  buildHandoffCanonicalMessage,
  buildLinkCompletionUrl,
  buildLinkFailureUrl,
  buildLoginCompleteUrl,
  buildLoginErrorUrl,
  buildProviderCallbackUrl,
  buildProviderStartUrl,
  buildStartCanonicalMessage,
  computeJwkThumbprint,
  createFederatedAuthStateUtil,
  FederatedLinkCookieHeaderTooLargeError,
  FederatedLinkStateCookieTooLargeError,
  generateLinkStateValue,
  generateSignInStateValue,
  LINK_COOKIE_HEADER_RACE_RESERVE_BYTES,
  LINK_STATE_COOKIE_PATH,
  LINK_STATE_COOKIE_PREFIX,
  LINK_STATE_VALUE_PATTERN,
  LINK_STATE_VALUE_PREFIX,
  linkCookieNameFor,
  MAX_LINK_COOKIE_HEADER_BYTES,
  MAX_LINK_FLOW_COOKIE_COUNT,
  MAX_LINK_STATE_COOKIE_VALUE_BYTES,
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

    test('design decision 5: verify() rejects a payload carrying the deprecated link fields or the link flow marker', () => {
      const util = createFederatedAuthStateUtil(makeFakeCrowi('secret-1'));
      // Craft a cookie value carrying the reserved fields directly (bypassing
      // the type-safe `issue()` — a hostile/legacy value is exactly what
      // this guard must reject even though TypeScript would never let a
      // caller construct it through the public API).
      const key = crypto.hkdfSync('sha256', 'secret-1', Buffer.alloc(0), 'crowi:oauth-state-hmac:v1', 32);
      const sign = (payload: unknown) => {
        const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
        const mac = crypto.createHmac('sha256', Buffer.from(key)).update(payloadB64).digest('base64url');
        return `${payloadB64}.${mac}`;
      };
      const base = { state: 's', provider: 'test-provider', expiresAt: Date.now() + 300_000, continuePath: '/x', handoffJkt: 'jkt' };
      expect(util.verify(sign({ ...base, linkToUserId: 'victim' }), 'test-provider')).toBeNull();
      expect(util.verify(sign({ ...base, linkAuthVersion: 1 }), 'test-provider')).toBeNull();
      expect(util.verify(sign({ ...base, flow: 'link' }), 'test-provider')).toBeNull();
    });
  });

  describe('generateSignInStateValue / generateLinkStateValue (design decision 6)', () => {
    test('generateSignInStateValue produces a 43-char base64url value', () => {
      const value = generateSignInStateValue();
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(value.length).toBe(43);
    });

    test('generateSignInStateValue rejection-samples around the reserved link namespace', () => {
      const spy = jest.spyOn(crypto, 'randomBytes');
      const reserved = { toString: () => `${LINK_STATE_VALUE_PREFIX}${'x'.repeat(34)}` } as unknown as Buffer;
      const normal = { toString: () => 'a-normal-non-colliding-value-here-ok' } as unknown as Buffer;
      spy.mockReturnValueOnce(reserved).mockReturnValueOnce(normal);
      try {
        expect(generateSignInStateValue()).toBe('a-normal-non-colliding-value-here-ok');
        expect(spy).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
    });

    test('generateLinkStateValue always produces a 43-char crowilnk_-prefixed value matching LINK_STATE_VALUE_PATTERN', () => {
      for (let i = 0; i < 20; i += 1) {
        const value = generateLinkStateValue();
        expect(value.startsWith(LINK_STATE_VALUE_PREFIX)).toBe(true);
        expect(value.length).toBe(43);
        expect(LINK_STATE_VALUE_PATTERN.test(value)).toBe(true);
      }
    });

    test('generateSignInStateValue can never collide with LINK_STATE_VALUE_PATTERN by construction (many samples)', () => {
      for (let i = 0; i < 200; i += 1) {
        expect(LINK_STATE_VALUE_PATTERN.test(generateSignInStateValue())).toBe(false);
      }
    });
  });

  describe('linkCookieNameFor — namespace/prefix rejection', () => {
    test('builds the expected cookie name for a well-formed link state', () => {
      const state = generateLinkStateValue();
      expect(linkCookieNameFor(state)).toBe(`${LINK_STATE_COOKIE_PREFIX}${state}`);
    });

    test('returns null for a malformed/foreign state value (never builds a cookie name from an unvalidated value)', () => {
      expect(linkCookieNameFor('not-a-link-state')).toBeNull();
      expect(linkCookieNameFor('')).toBeNull();
      expect(linkCookieNameFor(`${LINK_STATE_VALUE_PREFIX}tooshort`)).toBeNull();
    });
  });

  describe('issueLink / verifyLink (link state cookie)', () => {
    const basePayload = () => ({
      flow: 'link' as const,
      state: generateLinkStateValue(),
      provider: 'google',
      userId: 'user-1',
      authVersion: 0,
      codeVerifier: 'a-verifier',
      oidcNonce: 'a-nonce',
    });

    test('round-trips a valid link state through issueLink/verifyLink using caller-supplied now', () => {
      const util = createFederatedAuthStateUtil(makeFakeCrowi('secret-1'));
      const now = 1_000_000;
      const payload = basePayload();
      const cookieValue = util.issueLink(payload, now);
      const decoded = util.verifyLink(cookieValue, { state: payload.state, provider: payload.provider }, now + 1000);
      expect(decoded).toMatchObject(payload);
      expect(decoded?.expiresAt).toBe(now + 300_000);
    });

    test('verifyLink uses ONLY the caller-supplied now, never Date.now() — a wildly different real clock does not affect the decision', () => {
      const util = createFederatedAuthStateUtil(makeFakeCrowi('secret-1'));
      const FAR_FUTURE = 5_000_000_000_000;
      const payload = basePayload();
      const cookieValue = util.issueLink(payload, FAR_FUTURE);
      // Still within the 300s window measured from FAR_FUTURE, even though this is nowhere near the real Date.now().
      expect(util.verifyLink(cookieValue, { state: payload.state, provider: payload.provider }, FAR_FUTURE + 299_999)).not.toBeNull();
      // Exact boundary instant: expiresAt === now must reject, matching link-completion.ts's `now >= stateExpiresAt` semantics.
      expect(util.verifyLink(cookieValue, { state: payload.state, provider: payload.provider }, FAR_FUTURE + 300_000)).toBeNull();
      expect(util.verifyLink(cookieValue, { state: payload.state, provider: payload.provider }, FAR_FUTURE + 300_001)).toBeNull();
    });

    test('verifyLink rejects a cookie signed under a different app secret', () => {
      const issuer = createFederatedAuthStateUtil(makeFakeCrowi('secret-A'));
      const verifier = createFederatedAuthStateUtil(makeFakeCrowi('secret-B'));
      const payload = basePayload();
      const cookieValue = issuer.issueLink(payload, Date.now());
      expect(verifier.verifyLink(cookieValue, { state: payload.state, provider: payload.provider }, Date.now())).toBeNull();
    });

    test('verifyLink rejects an ORDINARY sign-in state cookie value fed into it (flow !== "link")', () => {
      const util = createFederatedAuthStateUtil(makeFakeCrowi('secret-1'));
      const signInValue = util.issue({ state: 'a-state', provider: 'google', continuePath: '/x', handoffJkt: 'jkt' });
      expect(util.verifyLink(signInValue, { state: 'a-state', provider: 'google' }, Date.now())).toBeNull();
    });

    test('verifyLink rejects a provider mismatch', () => {
      const util = createFederatedAuthStateUtil(makeFakeCrowi('secret-1'));
      const payload = basePayload();
      const cookieValue = util.issueLink(payload, Date.now());
      expect(util.verifyLink(cookieValue, { state: payload.state, provider: 'a-different-provider' }, Date.now())).toBeNull();
    });

    test('verifyLink rejects a state mismatch (the cookie payload state must equal the query-derived expected state)', () => {
      const util = createFederatedAuthStateUtil(makeFakeCrowi('secret-1'));
      const payload = basePayload();
      const cookieValue = util.issueLink(payload, Date.now());
      expect(util.verifyLink(cookieValue, { state: generateLinkStateValue(), provider: payload.provider }, Date.now())).toBeNull();
    });

    test('verifyLink returns null for a missing cookie', () => {
      const util = createFederatedAuthStateUtil(makeFakeCrowi('secret-1'));
      expect(util.verifyLink(undefined, { state: 'x', provider: 'google' }, Date.now())).toBeNull();
    });

    test('per-cookie link value: exactly 4096 bytes is accepted, 4097 bytes throws FederatedLinkStateCookieTooLargeError', () => {
      const util = createFederatedAuthStateUtil(makeFakeCrowi('secret-1'));
      const payload = basePayload();
      let padLength = 0;
      let lastValue: string | null = null;
      for (;;) {
        try {
          lastValue = util.issueLink({ ...payload, oidcNonce: 'x'.repeat(padLength) }, Date.now());
          padLength += 1;
        } catch (err) {
          expect(err).toBeInstanceOf(FederatedLinkStateCookieTooLargeError);
          // Deliberately no value/provider/byte-count fields on the error — only Error's own name/message.
          expect(Object.keys(err as Error).sort()).toEqual(['name']);
          expect(err).not.toHaveProperty('value');
          expect(err).not.toHaveProperty('provider');
          expect(err).not.toHaveProperty('byteLength');
          break;
        }
        if (padLength > MAX_LINK_STATE_COOKIE_VALUE_BYTES) throw new Error('boundary not found within a reasonable range');
      }
      expect(lastValue).not.toBeNull();
      expect(Buffer.byteLength(lastValue as string, 'utf8')).toBe(MAX_LINK_STATE_COOKIE_VALUE_BYTES);
    });

    test('linkCookieOptions match the design decision 6 contract (Path=/api/auth/providers, Max-Age=300)', () => {
      const prodUtil = createFederatedAuthStateUtil(makeFakeCrowi('secret-1', 'production'));
      expect(prodUtil.linkCookieOptions).toEqual({
        httpOnly: true,
        sameSite: 'Lax',
        secure: true,
        path: LINK_STATE_COOKIE_PATH,
        maxAge: 300,
      });
      const devUtil = createFederatedAuthStateUtil(makeFakeCrowi('secret-1', 'development'));
      expect(devUtil.linkCookieOptions.secure).toBe(false);
    });
  });

  describe('planLinkCookiePrune (design decision 7)', () => {
    function makeUtil() {
      return createFederatedAuthStateUtil(makeFakeCrowi('secret-1'));
    }

    function issueNamedLinkCookie(util: ReturnType<typeof makeUtil>, now: number, provider = 'google'): { name: string; token: string; state: string } {
      const state = generateLinkStateValue();
      const value = util.issueLink({ flow: 'link', state, provider, userId: 'user-1', authVersion: 0 }, now);
      const name = linkCookieNameFor(state) as string;
      return { name, token: `${name}=${value}`, state };
    }

    test('ordinary ("session=abc") cookies are always retained, never expired', () => {
      const util = makeUtil();
      const now = Date.now();
      const { token: linkToken } = issueNamedLinkCookie(util, now);
      const header = `session=abc; ${linkToken}`;
      const plan = util.planLinkCookiePrune(header, 'crowi.oauthLinkState.freshstate', 'fresh-value', now);
      expect(plan.expireCookieNames).toEqual([]);
    });

    test('an INVALID link cookie (bad signature) is an unconditional prune candidate', () => {
      const util = makeUtil();
      const now = Date.now();
      const badName = `${LINK_STATE_COOKIE_PREFIX}${'a'.repeat(34)}`;
      const header = `${badName}=not-a-valid-signed-value`;
      const plan = util.planLinkCookiePrune(header, 'crowi.oauthLinkState.freshstate', 'fresh-value', now);
      expect(plan.expireCookieNames).toContain(badName);
    });

    test('a signed-but-EXPIRED link cookie is an unconditional prune candidate', () => {
      const util = makeUtil();
      const now = 1_000_000;
      const { name, token } = issueNamedLinkCookie(util, now);
      const plan = util.planLinkCookiePrune(token, 'crowi.oauthLinkState.freshstate', 'fresh-value', now + 300_001);
      expect(plan.expireCookieNames).toContain(name);
    });

    test('count admission: 5 live link cookies + 1 fresh prunes exactly the OLDEST one down to 4 retained', () => {
      const util = makeUtil();
      const now = Date.now();
      // Issue 5 with strictly increasing expiresAt (oldest first).
      const cookies = Array.from({ length: MAX_LINK_FLOW_COOKIE_COUNT }, (_, i) => issueNamedLinkCookie(util, now + i));
      const header = cookies.map((c) => c.token).join('; ');
      const plan = util.planLinkCookiePrune(header, 'crowi.oauthLinkState.freshstate', 'fresh-value', now + MAX_LINK_FLOW_COOKIE_COUNT);
      expect(plan.expireCookieNames).toEqual([cookies[0].name]);
    });

    test('a single fresh link-start (no pre-existing link cookies) never prunes anything', () => {
      const util = makeUtil();
      const now = Date.now();
      const plan = util.planLinkCookiePrune(undefined, 'crowi.oauthLinkState.freshstate', 'fresh-value', now);
      expect(plan.expireCookieNames).toEqual([]);
      expect(plan.projectedCookieHeaderBytes).toBe(Buffer.byteLength('crowi.oauthLinkState.freshstate=fresh-value', 'utf8'));
    });

    test('byte-budget admission: raw Cookie header bytes include ordinary cookies, and prune the oldest live link cookie until the projection fits 11 KiB', () => {
      const util = makeUtil();
      const now = Date.now();
      // A large ordinary cookie that alone stays well under budget, plus two link cookies whose combined size pushes over 11 KiB.
      const bigOrdinary = `session=${'a'.repeat(2000)}`;
      const older = issueNamedLinkCookie(util, now);
      const newer = issueNamedLinkCookie(util, now + 1);
      // Pad the fresh cookie value itself to force the projection over budget, isolating the byte-budget path from the count path (only 2 existing link cookies, well under MAX_LINK_FLOW_COOKIE_COUNT).
      const freshValue = 'v'.repeat(9000);
      const header = `${bigOrdinary}; ${older.token}; ${newer.token}`;
      const plan = util.planLinkCookiePrune(header, 'crowi.oauthLinkState.freshstate', freshValue, now + 2);
      expect(plan.expireCookieNames).toContain(older.name);
      expect(plan.projectedCookieHeaderBytes).toBeLessThanOrEqual(MAX_LINK_COOKIE_HEADER_BYTES);
    });

    test('max fresh-pair reserve is exported and sized from the fixed cookie-name length + MAX_LINK_STATE_COOKIE_VALUE_BYTES', () => {
      // name = LINK_STATE_COOKIE_PREFIX (21 bytes) + 43-char state; '=' (1 byte); value up to MAX_LINK_STATE_COOKIE_VALUE_BYTES.
      const expected = Buffer.byteLength(LINK_STATE_COOKIE_PREFIX, 'utf8') + 43 + 1 + MAX_LINK_STATE_COOKIE_VALUE_BYTES;
      expect(LINK_COOKIE_HEADER_RACE_RESERVE_BYTES).toBe(expected);
    });

    test('when ordinary cookies alone (untouchable) already exceed the byte budget, pruning every link cookie is not enough and admission throws FederatedLinkCookieHeaderTooLargeError', () => {
      const util = makeUtil();
      const now = Date.now();
      const hugeOrdinary = `session=${'a'.repeat(MAX_LINK_COOKIE_HEADER_BYTES + 500)}`;
      const { token } = issueNamedLinkCookie(util, now);
      const header = `${hugeOrdinary}; ${token}`;
      expect(() => util.planLinkCookiePrune(header, 'crowi.oauthLinkState.freshstate', 'fresh-value', now)).toThrow(FederatedLinkCookieHeaderTooLargeError);
    });

    test('the header-too-large error carries no cookie value/byte-count fields', () => {
      const util = makeUtil();
      const now = Date.now();
      const hugeOrdinary = `session=${'a'.repeat(MAX_LINK_COOKIE_HEADER_BYTES + 500)}`;
      try {
        util.planLinkCookiePrune(hugeOrdinary, 'crowi.oauthLinkState.freshstate', 'fresh-value', now);
        throw new Error('expected planLinkCookiePrune to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(FederatedLinkCookieHeaderTooLargeError);
        expect(Object.keys(err as Error).sort()).toEqual(['name']);
        expect(err).not.toHaveProperty('value');
        expect(err).not.toHaveProperty('provider');
        expect(err).not.toHaveProperty('byteLength');
      }
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

    test('AC-20 regression: start/callback builder output for foo:bar and a/b providers is byte-for-byte the pre-existing 1-encode wire form', () => {
      const apiUrl = 'https://api.example.com';
      expect(buildProviderStartUrl(apiUrl, 'foo:bar')).toBe('https://api.example.com/api/auth/providers/foo%3Abar/start');
      expect(buildProviderCallbackUrl(apiUrl, 'foo:bar')).toBe('https://api.example.com/api/auth/providers/foo%3Abar/callback');
      expect(buildProviderStartUrl(apiUrl, 'a/b')).toBe('https://api.example.com/api/auth/providers/a%2Fb/start');
      expect(buildProviderCallbackUrl(apiUrl, 'a/b')).toBe('https://api.example.com/api/auth/providers/a%2Fb/callback');
    });

    test('buildLinkCompletionUrl carries ONLY provider + link_completion code', () => {
      const url = buildLinkCompletionUrl('https://wiki.example.com', 'google', 'the-code');
      const parsed = new URL(url);
      expect(parsed.pathname).toBe('/me');
      expect([...parsed.searchParams.keys()].sort()).toEqual(['link_completion', 'provider']);
      expect(parsed.searchParams.get('provider')).toBe('google');
      expect(parsed.searchParams.get('link_completion')).toBe('the-code');
    });

    test('buildLinkFailureUrl carries ONLY provider + the generic link_failed marker (no code, no accountLabel)', () => {
      const url = buildLinkFailureUrl('https://wiki.example.com', 'google');
      const parsed = new URL(url);
      expect(parsed.pathname).toBe('/me');
      expect([...parsed.searchParams.keys()].sort()).toEqual(['link', 'provider']);
      expect(parsed.searchParams.get('provider')).toBe('google');
      expect(parsed.searchParams.get('link')).toBe('link_failed');
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
