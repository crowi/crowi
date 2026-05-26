// Pin a stable WS_TOKEN_SECRET *before* the util module loads. The
// `createNotificationsTokenUtil` factory captures the resolved secret
// at first call and memoises the closure, so a later `process.env`
// mutation would not take effect.
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
      { selfUserId: 'user-1', iat: Math.floor(Date.now() / 1000) - 120, exp: Math.floor(Date.now() / 1000) - 60 },
      process.env.WS_TOKEN_SECRET as string,
      {
        issuer: 'crowi-notifications',
        algorithm: 'HS256',
      },
    );

    expect(util.verifyNotificationsToken(expired)).toBeNull();
  });
});
