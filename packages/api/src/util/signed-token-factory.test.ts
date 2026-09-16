// `src/test/setup.ts` (this project's `setupFilesAfterEnv`) seeds a valid
// `process.env.SECRET_TOKEN` before this file's own module code runs, so
// every default-`secretEnvVar` util built below (ws / presence /
// notifications / mail) resolves a real, stable secret without this file
// pinning one itself. Individual tests mutate the env to exercise the
// placeholder-rejection, alias, and fallback-secret paths, always restoring
// it in a `finally`.

import jwt from 'jsonwebtoken';
import { withSecretTokenEnv } from 'src/test/secret-token-env';
import { z } from 'zod';

import { createMailTokenUtil } from './mail-token';
import { createNotificationsTokenUtil } from './notifications-token';
import { createPresenceTokenUtil } from './presence-token';
import { createSignedTokenUtil, resolveSignedTokenSecret } from './signed-token-factory';
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

/** Decode a token's payload MINUS `iss` (jsonwebtoken's `sign()` rejects a payload that already carries `iss` when `options.issuer` is also passed) — shared by the AC-5 forgery-detection tests below. */
const decodeClaimsWithoutIssuer = (token: string): Record<string, unknown> => {
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  delete claims.iss;
  return claims;
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

describe('resolveSignedTokenSecret (AC-1 / AC-10 / AC-4) — default SECRET_TOKEN resolver with legacy WS_TOKEN_SECRET alias', () => {
  it('canonical-only: SECRET_TOKEN wins when WS_TOKEN_SECRET is unset', () => {
    withSecretTokenEnv({ SECRET_TOKEN: 'canonical-only-secret-value-32-chars-min', WS_TOKEN_SECRET: undefined }, () => {
      expect(resolveSignedTokenSecret()).toBe('canonical-only-secret-value-32-chars-min');
    });
  });

  it('legacy-only: WS_TOKEN_SECRET wins when SECRET_TOKEN is unset', () => {
    withSecretTokenEnv({ SECRET_TOKEN: undefined, WS_TOKEN_SECRET: 'legacy-only-secret-value-32-chars-min-1' }, () => {
      expect(resolveSignedTokenSecret()).toBe('legacy-only-secret-value-32-chars-min-1');
    });
  });

  it('both set: WS_TOKEN_SECRET (legacy alias) wins over SECRET_TOKEN', () => {
    withSecretTokenEnv({ SECRET_TOKEN: 'canonical-value-should-lose-32-chars-xx', WS_TOKEN_SECRET: 'legacy-value-should-win-32-chars-abcde' }, () => {
      expect(resolveSignedTokenSecret()).toBe('legacy-value-should-win-32-chars-abcde');
    });
  });

  it('a raw whitespace-padded legacy alias is returned UNTRIMMED (an existing valid token keeps verifying)', () => {
    withSecretTokenEnv({ SECRET_TOKEN: undefined, WS_TOKEN_SECRET: '  padded-legacy-secret-value-32-chars  ' }, () => {
      expect(resolveSignedTokenSecret()).toBe('  padded-legacy-secret-value-32-chars  ');
    });
  });

  it('an empty-string winner is skipped in favour of the next candidate', () => {
    withSecretTokenEnv({ SECRET_TOKEN: 'canonical-fallback-when-alias-empty-32c', WS_TOKEN_SECRET: '' }, () => {
      expect(resolveSignedTokenSecret()).toBe('canonical-fallback-when-alias-empty-32c');
    });
  });

  it.each([
    '   ',
    'changeme',
    'change-me',
    'replace-me',
    'your-secret-here',
    'your-secret-key',
    'this is default session secret',
  ])('a whitespace-only or placeholder winner (%j) short-circuits to the canonical random fallback instead of falling through to a valid next candidate', (invalidWinner) => {
    withSecretTokenEnv({ SECRET_TOKEN: 'this-would-win-if-fallthrough-happened-32c', WS_TOKEN_SECRET: invalidWinner }, () => {
      const resolved = resolveSignedTokenSecret();
      expect(resolved).not.toBe('this-would-win-if-fallthrough-happened-32c');
      expect(resolved).not.toBe(invalidWinner);
    });
  });

  it('with both SECRET_TOKEN and WS_TOKEN_SECRET unset, falls back to a memoized random per-process secret (separate calls agree)', () => {
    withSecretTokenEnv({ SECRET_TOKEN: undefined, WS_TOKEN_SECRET: undefined }, () => {
      const first = resolveSignedTokenSecret();
      const second = resolveSignedTokenSecret();
      expect(first).toBe(second);
    });
  });

  it('a custom secretEnvVar reads only that single key, with no alias applied', () => {
    withSecretTokenEnv({ SECRET_TOKEN: 'should-not-be-used-for-a-custom-env-var-32c' }, () => {
      withEnv('SIGNED_TOKEN_FACTORY_TEST_CUSTOM', 'custom-env-var-secret-value-32-chars-xx', () => {
        expect(resolveSignedTokenSecret('SIGNED_TOKEN_FACTORY_TEST_CUSTOM')).toBe('custom-env-var-secret-value-32-chars-xx');
      });
    });
  });

  it('the fallback warning for a never-before-used custom env key never echoes the generated secret value', () => {
    const KEY = 'SIGNED_TOKEN_FACTORY_TEST_WARN_REDACTION';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      withEnv(KEY, undefined, () => {
        // The factory silences its warning under NODE_ENV=test (jest's own
        // default), so this test must temporarily claim a different NODE_ENV
        // to observe the warning at all.
        withEnv('NODE_ENV', 'development', () => {
          const resolved = resolveSignedTokenSecret(KEY);
          expect(warnSpy).toHaveBeenCalled();
          const loggedText = warnSpy.mock.calls.map((args) => args.join(' ')).join('\n');
          expect(loggedText).toContain(KEY);
          expect(loggedText).not.toContain(resolved);
        });
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('AC-5 (security-critical regression): a placeholder signing secret must never sign a real token with the placeholder string itself', () => {
  const PLACEHOLDER = 'changeme';

  it('mail token (purpose: reset) is not signed with the placeholder secret', () => {
    withEnv('WS_TOKEN_SECRET', PLACEHOLDER, () => {
      const { token } = createMailTokenUtil().signMailToken({ purpose: 'reset', userId: 'user-1', email: 'a@example.com' });
      // If the token had been signed with the literal placeholder string,
      // an attacker who knows the placeholder could re-derive the exact
      // same JWT offline. Recompute it with the placeholder and assert it
      // does NOT match — i.e. some other (random fallback) secret was
      // actually used to sign the real token.
      const forged = jwt.sign(decodeClaimsWithoutIssuer(token), PLACEHOLDER, { issuer: 'crowi-mail-token', algorithm: 'HS256' });
      expect(forged).not.toBe(token);

      // And the placeholder-signed forgery must not verify against the
      // real util either.
      expect(createMailTokenUtil().verifyMailToken(forged, 'reset')).toBeNull();
    });
  });

  it('presence token is not signed with the placeholder secret', () => {
    withEnv('WS_TOKEN_SECRET', PLACEHOLDER, () => {
      const { token } = createPresenceTokenUtil().signPresenceToken({ userId: 'user-1', pageId: 'page-1' });
      const forged = jwt.sign(decodeClaimsWithoutIssuer(token), PLACEHOLDER, { issuer: 'crowi-presence', algorithm: 'HS256' });
      expect(forged).not.toBe(token);
      expect(createPresenceTokenUtil().verifyPresenceToken(forged)).toBeNull();
    });
  });

  it('notifications token is not signed with the placeholder secret', () => {
    withEnv('WS_TOKEN_SECRET', PLACEHOLDER, () => {
      const { token } = createNotificationsTokenUtil().signNotificationsToken({ selfUserId: 'user-1' });
      const forged = jwt.sign(decodeClaimsWithoutIssuer(token), PLACEHOLDER, { issuer: 'crowi-notifications', algorithm: 'HS256' });
      expect(forged).not.toBe(token);
      expect(createNotificationsTokenUtil().verifyNotificationsToken(forged)).toBeNull();
    });
  });

  it('collab wsToken is not signed with the placeholder secret (pre-existing protection, kept for parity)', () => {
    withEnv('WS_TOKEN_SECRET', PLACEHOLDER, () => {
      const { token } = createWsTokenUtil().signWsToken({ userId: 'user-1', pageId: 'page-1', readonly: false, epoch: 0 });
      const forged = jwt.sign(decodeClaimsWithoutIssuer(token), PLACEHOLDER, { issuer: 'crowi-collab', algorithm: 'HS256' });
      expect(forged).not.toBe(token);
      expect(createWsTokenUtil().verifyWsToken(forged)).toBeNull();
    });
  });

  it('AC-5 canonical parity: a placeholder SECRET_TOKEN (no WS_TOKEN_SECRET set) is also never used to sign', () => {
    withSecretTokenEnv({ SECRET_TOKEN: PLACEHOLDER, WS_TOKEN_SECRET: undefined }, () => {
      const { token } = createMailTokenUtil().signMailToken({ purpose: 'reset', userId: 'user-1', email: 'a@example.com' });
      const forged = jwt.sign(decodeClaimsWithoutIssuer(token), PLACEHOLDER, { issuer: 'crowi-mail-token', algorithm: 'HS256' });
      expect(forged).not.toBe(token);
      expect(createMailTokenUtil().verifyMailToken(forged, 'reset')).toBeNull();
    });
  });
});
