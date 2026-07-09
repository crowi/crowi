// Pin a stable WS_TOKEN_SECRET before any token util is constructed
// below. The secret is resolved fresh on every
// `createNotificationsTokenUtil()` call (no cached singleton — see
// signed-token-factory.ts), not at module import time; two tests below
// sign directly with `process.env.WS_TOKEN_SECRET`, so a stable value
// must be in place for the whole file.
process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import jwt from 'jsonwebtoken';
import { createNotificationsTokenUtil } from './notifications-token';
import { createPresenceTokenUtil } from './presence-token';
import { createWsTokenUtil } from './ws-token';

/**
 * Tests for the per-user notifications token util.
 *
 * Mirrors the presence-token / ws-token suites: we cover the
 * round-trip (sign → verify), the issuer isolation (a presence or
 * collab token must NOT verify as a notifications token even though
 * they share `WS_TOKEN_SECRET`), and tamper detection.
 */

describe('createNotificationsTokenUtil', () => {
  it('signs a token whose verify round-trip recovers selfUserId', () => {
    const util = createNotificationsTokenUtil();
    const { token, expiresAt } = util.signNotificationsToken({ selfUserId: 'user-1' });

    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    // 60-second TTL — the realisation of the spec's short-lived
    // notification invalidation channel.
    const deltaSeconds = (expiresAt.getTime() - Date.now()) / 1000;
    expect(deltaSeconds).toBeGreaterThan(30);
    expect(deltaSeconds).toBeLessThanOrEqual(60);

    const verified = util.verifyNotificationsToken(token);
    expect(verified).not.toBeNull();
    expect(verified?.selfUserId).toBe('user-1');
  });

  it('encodes the crowi-notifications issuer + a 60-second TTL', () => {
    const util = createNotificationsTokenUtil();
    const { token } = util.signNotificationsToken({ selfUserId: 'user-1' });

    const [, payloadB64] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    expect(decoded.iss).toBe('crowi-notifications');
    expect(decoded.selfUserId).toBe('user-1');
    expect(typeof decoded.iat).toBe('number');
    expect(typeof decoded.exp).toBe('number');
    expect(decoded.exp - decoded.iat).toBe(60);
  });

  it('rejects a presence token presented to the notifications verifier (issuer isolation)', () => {
    // Presence + notifications share WS_TOKEN_SECRET but differ by `iss`.
    // A leaked presence token must NOT verify against the notifications
    // channel.
    const presenceUtil = createPresenceTokenUtil();
    const presenceResult = presenceUtil.signPresenceToken({ userId: 'user-1', pageId: 'page-1' });
    const notificationsUtil = createNotificationsTokenUtil();

    expect(notificationsUtil.verifyNotificationsToken(presenceResult.token)).toBeNull();
  });

  it('rejects a collab wsToken presented to the notifications verifier (issuer isolation)', () => {
    const collabUtil = createWsTokenUtil();
    const collabResult = collabUtil.signWsToken({ userId: 'user-1', pageId: 'page-1', readonly: false });
    const notificationsUtil = createNotificationsTokenUtil();

    expect(notificationsUtil.verifyNotificationsToken(collabResult.token)).toBeNull();
  });

  it('rejects a token whose signature was tampered with', () => {
    const util = createNotificationsTokenUtil();
    const { token } = util.signNotificationsToken({ selfUserId: 'user-1' });
    const segments = token.split('.');
    // Flip the last character of the signature segment.
    const sig = segments[2];
    const tampered = `${segments[0]}.${segments[1]}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;

    expect(util.verifyNotificationsToken(tampered)).toBeNull();
  });

  it('rejects a token whose payload fails schema validation (missing selfUserId)', () => {
    // Sign a payload that the issuer + secret accept but the
    // `NotificationsTokenPayloadSchema` rejects (no `selfUserId`).
    const malformed = jwt.sign({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 }, process.env.WS_TOKEN_SECRET as string, {
      issuer: 'crowi-notifications',
      algorithm: 'HS256',
    });

    const util = createNotificationsTokenUtil();
    expect(util.verifyNotificationsToken(malformed)).toBeNull();
  });

  it('rejects an expired token', () => {
    const util = createNotificationsTokenUtil();
    // Synthesise an already-expired token directly so we don't have to
    // wait 60 seconds — the verifier delegates expiry to jsonwebtoken.
    const expired = jwt.sign(
      { selfUserId: 'user-1', jti: '11111111-1111-4111-8111-111111111111', iat: Math.floor(Date.now() / 1000) - 120, exp: Math.floor(Date.now() / 1000) - 60 },
      process.env.WS_TOKEN_SECRET as string,
      {
        issuer: 'crowi-notifications',
        algorithm: 'HS256',
      },
    );

    expect(util.verifyNotificationsToken(expired)).toBeNull();
  });

  it('mints a fresh `jti` per sign so two same-second tokens are byte-different', () => {
    // Without `jti`, two `signNotificationsToken` calls inside one
    // second produce identical iat/exp pairs and therefore byte-
    // identical JWT strings — which breaks the browser's react
    // `useEffect` dependency on the token (a stable string does not
    // re-trigger the WebSocket reconnect). The fix is a random `jti`
    // mixed into every payload; verify the two outputs differ.
    const util = createNotificationsTokenUtil();
    const a = util.signNotificationsToken({ selfUserId: 'user-1' });
    const b = util.signNotificationsToken({ selfUserId: 'user-1' });
    expect(a.token).not.toBe(b.token);

    // Both tokens must still verify (the verifier doesn't inspect jti
    // beyond schema validation).
    expect(util.verifyNotificationsToken(a.token)).not.toBeNull();
    expect(util.verifyNotificationsToken(b.token)).not.toBeNull();

    // Decode both payloads and assert the `jti` differs.
    const decode = (token: string): Record<string, unknown> => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const payloadA = decode(a.token);
    const payloadB = decode(b.token);
    expect(typeof payloadA.jti).toBe('string');
    expect(typeof payloadB.jti).toBe('string');
    expect(payloadA.jti).not.toBe(payloadB.jti);
  });

  it('returns a new util instance per call (no cached singleton)', () => {
    // The previous implementation memoised a singleton across calls,
    // which pinned the secret to whatever env state existed at the
    // first call — a problem for boot / test ordering. The fix makes
    // each call build a fresh util; verify the two refs are distinct.
    const a = createNotificationsTokenUtil();
    const b = createNotificationsTokenUtil();
    expect(a).not.toBe(b);

    // Crucially, tokens minted by one must still verify against the
    // other (because both resolve `WS_TOKEN_SECRET` from the same env).
    const { token } = a.signNotificationsToken({ selfUserId: 'user-roundtrip' });
    expect(b.verifyNotificationsToken(token)?.selfUserId).toBe('user-roundtrip');
  });

  it('AC-5 (security-critical regression): notifications and presence tokens are NOT signed with a placeholder WS_TOKEN_SECRET itself', () => {
    // Before signed-token-factory.ts, only ws-token.ts rejected known
    // placeholder secrets (`changeme` etc). notifications-token.ts and
    // presence-token.ts signed with the placeholder string verbatim,
    // letting anyone who knows the placeholder forge a valid token for
    // either channel. Both now route through the shared factory, so
    // both get the same rejection.
    const original = process.env.WS_TOKEN_SECRET;
    process.env.WS_TOKEN_SECRET = 'changeme';
    try {
      // Strip `iss` from the decoded claims: jsonwebtoken's `sign()`
      // rejects a payload that already carries `iss` when
      // `options.issuer` is also passed.
      const decode = (token: string): Record<string, unknown> => {
        const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        delete claims.iss;
        return claims;
      };

      const notifResult = createNotificationsTokenUtil().signNotificationsToken({ selfUserId: 'user-1' });
      const forgedNotif = jwt.sign(decode(notifResult.token), 'changeme', { issuer: 'crowi-notifications', algorithm: 'HS256' });
      expect(forgedNotif).not.toBe(notifResult.token);
      expect(createNotificationsTokenUtil().verifyNotificationsToken(forgedNotif)).toBeNull();

      const presenceResult = createPresenceTokenUtil().signPresenceToken({ userId: 'user-1', pageId: 'page-1' });
      const forgedPresence = jwt.sign(decode(presenceResult.token), 'changeme', { issuer: 'crowi-presence', algorithm: 'HS256' });
      expect(forgedPresence).not.toBe(presenceResult.token);
      expect(createPresenceTokenUtil().verifyPresenceToken(forgedPresence)).toBeNull();
    } finally {
      if (original === undefined) delete process.env.WS_TOKEN_SECRET;
      else process.env.WS_TOKEN_SECRET = original;
    }
  });

  it('memoizes the random fallback secret when WS_TOKEN_SECRET is unset, so a separate mint / verify util pair still agrees (regression: unthrottled notifications WS reconnect storm)', () => {
    // Mirrors the real mint (HTTP `GET /notifications/token`) / verify (WS
    // upgrade) split: each side builds its own util instance. Without a
    // memoized fallback, `resolveNotificationsTokenSecret()` minted a fresh
    // `crypto.randomBytes` secret on every call, so mint and verify (almost)
    // never agreed and every handshake was rejected with 4401 — see
    // notifications-token.ts's `fallbackSecret` (same pattern as
    // mail-token.ts's `resolveMailTokenSecret`).
    const original = process.env.WS_TOKEN_SECRET;
    delete process.env.WS_TOKEN_SECRET;
    try {
      const mintUtil = createNotificationsTokenUtil();
      const { token } = mintUtil.signNotificationsToken({ selfUserId: 'user-1' });

      const verifyUtil = createNotificationsTokenUtil();
      const verified = verifyUtil.verifyNotificationsToken(token);

      expect(verified).not.toBeNull();
      expect(verified?.selfUserId).toBe('user-1');
    } finally {
      if (original === undefined) delete process.env.WS_TOKEN_SECRET;
      else process.env.WS_TOKEN_SECRET = original;
    }
  });
});
