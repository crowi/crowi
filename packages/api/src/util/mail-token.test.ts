// Pin a stable WS_TOKEN_SECRET before the util module loads (the
// module-load-time warn check reads the env at import time). Mirrors
// notifications-token.test.ts.
process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import jwt from 'jsonwebtoken';
import { createMailTokenUtil } from './mail-token';
import { createNotificationsTokenUtil } from './notifications-token';

describe('createMailTokenUtil', () => {
  const claims = { purpose: 'invite' as const, userId: 'user-1', email: 'a@example.com' };

  it('round-trips sign → verify for the matching purpose', () => {
    const util = createMailTokenUtil();
    const { token, expiresAt } = util.signMailToken(claims);

    expect(typeof token).toBe('string');
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const verified = util.verifyMailToken(token, 'invite');
    expect(verified).not.toBeNull();
    expect(verified?.userId).toBe('user-1');
    expect(verified?.email).toBe('a@example.com');
    expect(verified?.purpose).toBe('invite');
  });

  it('applies per-purpose TTLs (invite 7d, reset 1h)', () => {
    const util = createMailTokenUtil();
    const invite = util.signMailToken({ ...claims, purpose: 'invite' });
    const reset = util.signMailToken({ ...claims, purpose: 'reset' });

    const inviteDelta = (invite.expiresAt.getTime() - Date.now()) / 1000;
    const resetDelta = (reset.expiresAt.getTime() - Date.now()) / 1000;
    expect(inviteDelta).toBeGreaterThan(6 * 24 * 60 * 60);
    expect(resetDelta).toBeLessThanOrEqual(60 * 60);
  });

  it('rejects a token whose purpose does not match', () => {
    const util = createMailTokenUtil();
    const { token } = util.signMailToken({ ...claims, purpose: 'invite' });
    expect(util.verifyMailToken(token, 'reset')).toBeNull();
    expect(util.verifyMailToken(token, 'activate')).toBeNull();
  });

  it('rejects a tampered / wrong-secret token', () => {
    const util = createMailTokenUtil();
    const { token } = util.signMailToken(claims);
    expect(util.verifyMailToken(`${token}x`, 'invite')).toBeNull();

    const foreign = jwt.sign({ ...claims, iat: Math.floor(Date.now() / 1000) }, 'a-different-secret', {
      issuer: 'crowi-mail-token',
      algorithm: 'HS256',
    });
    expect(util.verifyMailToken(foreign, 'invite')).toBeNull();
  });

  it('rejects an expired token', () => {
    const util = createMailTokenUtil();
    const past = Math.floor(Date.now() / 1000) - 10;
    const expired = jwt.sign({ ...claims, iat: past - 60, exp: past }, process.env.WS_TOKEN_SECRET as string, {
      issuer: 'crowi-mail-token',
      algorithm: 'HS256',
    });
    expect(util.verifyMailToken(expired, 'invite')).toBeNull();
  });

  it('does not cross-verify a notifications token (issuer isolation)', () => {
    const mailUtil = createMailTokenUtil();
    const notifUtil = createNotificationsTokenUtil();
    const { token } = notifUtil.signNotificationsToken({ selfUserId: 'user-1' });
    expect(mailUtil.verifyMailToken(token, 'invite')).toBeNull();
  });
});
