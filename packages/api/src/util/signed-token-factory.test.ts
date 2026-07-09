// Pin a stable WS_TOKEN_SECRET before any util is constructed below —
// the secret is resolved fresh on every `createSignedTokenUtil()` call,
// not at module import time (mirrors notifications-token.test.ts /
// mail-token.test.ts). Individual tests below mutate the env to
// exercise the placeholder-rejection and fallback-secret paths, always
// restoring it in a `finally`.
process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { createMailTokenUtil } from './mail-token';
import { createNotificationsTokenUtil } from './notifications-token';
import { createPresenceTokenUtil } from './presence-token';
import { createSignedTokenUtil, isSignedTokenSecretConfiguredFromEnv } from './signed-token-factory';
import { createWsTokenUtil } from './ws-token';

const withEnv = (key: string, value: string | undefined, run: () => void): void => {
  const original = process.env[key];
  try {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    run();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
};

describe('createSignedTokenUtil (AC-1 / AC-2 / AC-4)', () => {
  const ClaimsSchema = z.object({ subject: z.string(), iat: z.number().int(), exp: z.number().int() });

  it('round-trips sign -> verify and encodes the configured issuer + TTL', () => {
    const util = createSignedTokenUtil({
      issuer: 'crowi-test-issuer-a',
      ttlSeconds: 120,
      payloadSchema: ClaimsSchema,
    });

    const { token, expiresAt } = util.sign({ subject: 'user-1' });
    const deltaSeconds = (expiresAt.getTime() - Date.now()) / 1000;
    expect(deltaSeconds).toBeGreaterThan(100);
    expect(deltaSeconds).toBeLessThanOrEqual(120);

    const verified = util.verify(token);
    expect(verified).not.toBeNull();
    expect(verified?.subject).toBe('user-1');

    const [, payloadB64] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    expect(decoded.iss).toBe('crowi-test-issuer-a');
    expect(decoded.exp - decoded.iat).toBe(120);
  });

  it('supports a claims-dependent ttlSeconds function (mail-token.ts style)', () => {
    const util = createSignedTokenUtil({
      issuer: 'crowi-test-dynamic-ttl',
      ttlSeconds: (claims: { subject: string }) => (claims.subject === 'short' ? 10 : 1000),
      payloadSchema: z.object({ subject: z.string(), iat: z.number().int(), exp: z.number().int() }),
    });

    const short = util.sign({ subject: 'short' });
    const long = util.sign({ subject: 'long' });
    expect((short.expiresAt.getTime() - Date.now()) / 1000).toBeLessThanOrEqual(10);
    expect((long.expiresAt.getTime() - Date.now()) / 1000).toBeGreaterThan(100);
  });

  it('two utils with different issuers sharing the same secret cannot cross-verify (issuer isolation)', () => {
    const a = createSignedTokenUtil({ issuer: 'crowi-test-issuer-a', ttlSeconds: 60, payloadSchema: ClaimsSchema });
    const b = createSignedTokenUtil({ issuer: 'crowi-test-issuer-b', ttlSeconds: 60, payloadSchema: ClaimsSchema });

    const { token } = a.sign({ subject: 'user-1' });
    expect(b.verify(token)).toBeNull();
    expect(a.verify(token)?.subject).toBe('user-1');
  });

  it('rejects a token whose payload fails schema validation', () => {
    const util = createSignedTokenUtil({
      issuer: 'crowi-test-schema',
      ttlSeconds: 60,
      payloadSchema: z.object({ requiredField: z.string(), iat: z.number().int(), exp: z.number().int() }),
    });
    // Sign via a differently-typed util sharing the same issuer/secret so
    // the JWT itself verifies but the payload schema rejects it.
    const looseUtil = createSignedTokenUtil({
      issuer: 'crowi-test-schema',
      ttlSeconds: 60,
      payloadSchema: z.object({ iat: z.number().int(), exp: z.number().int() }),
    });
    const { token } = looseUtil.sign({});

    expect(util.verify(token)).toBeNull();
  });

  it('rejects an expired token and a tampered token', () => {
    const util = createSignedTokenUtil({ issuer: 'crowi-test-expiry', ttlSeconds: -1, payloadSchema: ClaimsSchema });
    const { token } = util.sign({ subject: 'user-1' });
    expect(util.verify(token)).toBeNull();

    const validUtil = createSignedTokenUtil({ issuer: 'crowi-test-tamper', ttlSeconds: 60, payloadSchema: ClaimsSchema });
    const { token: validToken } = validUtil.sign({ subject: 'user-1' });
    const segments = validToken.split('.');
    const sig = segments[2];
    const tampered = `${segments[0]}.${segments[1]}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;
    expect(validUtil.verify(tampered)).toBeNull();
  });

  it('memoizes the random fallback secret per secretEnvVar when unset, so separate mint / verify util instances still agree (AC-3)', () => {
    withEnv('SIGNED_TOKEN_FACTORY_TEST_SECRET', undefined, () => {
      const mintUtil = createSignedTokenUtil({
        issuer: 'crowi-test-fallback',
        ttlSeconds: 60,
        payloadSchema: ClaimsSchema,
        secretEnvVar: 'SIGNED_TOKEN_FACTORY_TEST_SECRET',
      });
      const { token } = mintUtil.sign({ subject: 'user-1' });

      const verifyUtil = createSignedTokenUtil({
        issuer: 'crowi-test-fallback',
        ttlSeconds: 60,
        payloadSchema: ClaimsSchema,
        secretEnvVar: 'SIGNED_TOKEN_FACTORY_TEST_SECRET',
      });
      expect(verifyUtil.verify(token)?.subject).toBe('user-1');
    });
  });

  it('re-reads the env on every call — a secret set after the first call is picked up by a later call', () => {
    withEnv('SIGNED_TOKEN_FACTORY_TEST_SECRET_2', undefined, () => {
      const beforeUtil = createSignedTokenUtil({
        issuer: 'crowi-test-reread',
        ttlSeconds: 60,
        payloadSchema: ClaimsSchema,
        secretEnvVar: 'SIGNED_TOKEN_FACTORY_TEST_SECRET_2',
      });
      const { token: beforeToken } = beforeUtil.sign({ subject: 'user-1' });

      process.env.SIGNED_TOKEN_FACTORY_TEST_SECRET_2 = 'a-real-explicit-secret-value';
      const afterUtil = createSignedTokenUtil({
        issuer: 'crowi-test-reread',
        ttlSeconds: 60,
        payloadSchema: ClaimsSchema,
        secretEnvVar: 'SIGNED_TOKEN_FACTORY_TEST_SECRET_2',
      });

      // The pre-env-set fallback secret and the post-env-set real secret
      // differ, so a token minted before the env was set does not verify
      // against the util built after.
      expect(afterUtil.verify(beforeToken)).toBeNull();

      const { token: afterToken } = afterUtil.sign({ subject: 'user-2' });
      expect(afterUtil.verify(afterToken)?.subject).toBe('user-2');
    });
  });
});

describe('isSignedTokenSecretConfiguredFromEnv (AC-4)', () => {
  const KEY = 'SIGNED_TOKEN_FACTORY_TEST_PLACEHOLDER_CHECK';

  it('is false when unset or empty', () => {
    withEnv(KEY, undefined, () => expect(isSignedTokenSecretConfiguredFromEnv(KEY)).toBe(false));
    withEnv(KEY, '', () => expect(isSignedTokenSecretConfiguredFromEnv(KEY)).toBe(false));
    withEnv(KEY, '   ', () => expect(isSignedTokenSecretConfiguredFromEnv(KEY)).toBe(false));
  });

  it('is false for every known placeholder value, case-insensitively and trimmed', () => {
    const placeholders = [
      'changeme',
      'CHANGEME',
      ' ChangeMe ',
      'change-me',
      'replace-me',
      'your-secret-here',
      'dev-only-ws-token-secret-replace-in-production-0000=',
    ];
    for (const placeholder of placeholders) {
      withEnv(KEY, placeholder, () => expect(isSignedTokenSecretConfiguredFromEnv(KEY)).toBe(false));
    }
  });

  it('is true for a real, non-placeholder secret', () => {
    withEnv(KEY, 'a-real-32-byte-base64-secret-value==', () => expect(isSignedTokenSecretConfiguredFromEnv(KEY)).toBe(true));
  });
});

describe('AC-5 (security-critical regression): a placeholder WS_TOKEN_SECRET must never sign a real token with the placeholder string itself', () => {
  const PLACEHOLDER = 'changeme';

  // Decode the payload MINUS `iss` (jsonwebtoken's `sign()` rejects a
  // payload that already carries `iss` when `options.issuer` is also
  // passed) — `iat` / `exp` are kept so the re-signed forgery carries
  // the exact same claims as the real token, isolating the comparison
  // to "which secret was used".
  const decodeClaims = (token: string): Record<string, unknown> => {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    delete claims.iss;
    return claims;
  };

  it('mail token (purpose: reset) is not signed with the placeholder secret', () => {
    withEnv('WS_TOKEN_SECRET', PLACEHOLDER, () => {
      const { token } = createMailTokenUtil().signMailToken({ purpose: 'reset', userId: 'user-1', email: 'a@example.com' });
      // If the token had been signed with the literal placeholder string,
      // an attacker who knows the placeholder could re-derive the exact
      // same JWT offline. Recompute it with the placeholder and assert it
      // does NOT match — i.e. some other (random fallback) secret was
      // actually used to sign the real token.
      const forged = jwt.sign(decodeClaims(token), PLACEHOLDER, { issuer: 'crowi-mail-token', algorithm: 'HS256' });
      expect(forged).not.toBe(token);

      // And the placeholder-signed forgery must not verify against the
      // real util either.
      expect(createMailTokenUtil().verifyMailToken(forged, 'reset')).toBeNull();
    });
  });

  it('presence token is not signed with the placeholder secret', () => {
    withEnv('WS_TOKEN_SECRET', PLACEHOLDER, () => {
      const { token } = createPresenceTokenUtil().signPresenceToken({ userId: 'user-1', pageId: 'page-1' });
      const forged = jwt.sign(decodeClaims(token), PLACEHOLDER, { issuer: 'crowi-presence', algorithm: 'HS256' });
      expect(forged).not.toBe(token);
      expect(createPresenceTokenUtil().verifyPresenceToken(forged)).toBeNull();
    });
  });

  it('notifications token is not signed with the placeholder secret', () => {
    withEnv('WS_TOKEN_SECRET', PLACEHOLDER, () => {
      const { token } = createNotificationsTokenUtil().signNotificationsToken({ selfUserId: 'user-1' });
      const forged = jwt.sign(decodeClaims(token), PLACEHOLDER, { issuer: 'crowi-notifications', algorithm: 'HS256' });
      expect(forged).not.toBe(token);
      expect(createNotificationsTokenUtil().verifyNotificationsToken(forged)).toBeNull();
    });
  });

  it('collab wsToken is not signed with the placeholder secret (pre-existing protection, kept for parity)', () => {
    withEnv('WS_TOKEN_SECRET', PLACEHOLDER, () => {
      const { token } = createWsTokenUtil().signWsToken({ userId: 'user-1', pageId: 'page-1', readonly: false });
      const forged = jwt.sign(decodeClaims(token), PLACEHOLDER, { issuer: 'crowi-collab', algorithm: 'HS256' });
      expect(forged).not.toBe(token);
      expect(createWsTokenUtil().verifyWsToken(forged)).toBeNull();
    });
  });
});
