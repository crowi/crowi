// Pin a stable WS_TOKEN_SECRET before any token util is constructed
// below — the secret is resolved fresh on every `createXTokenUtil()`
// call (see signed-token-factory.ts), not at module import time. The
// "rejects an expired token" test signs directly with
// `process.env.WS_TOKEN_SECRET`, so a stable value must be in place for
// the whole file. Mirrors notifications-token.test.ts.
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

  it('AC-5 (security-critical regression): a password-reset token is NOT signed with a placeholder WS_TOKEN_SECRET itself', () => {
    // Before signed-token-factory.ts, mail-token.ts had no placeholder
    // rejection (unlike ws-token.ts): a `.env` copied from an older
    // template with `WS_TOKEN_SECRET=changeme` left uncorrected in
    // production would sign password-reset links with that world-known
    // string, letting anyone forge a valid reset token for any user.
    const original = process.env.WS_TOKEN_SECRET;
    process.env.WS_TOKEN_SECRET = 'changeme';
    try {
      const { token } = createMailTokenUtil().signMailToken({ purpose: 'reset', userId: 'victim-user-id', email: 'victim@example.com' });

      // A forgery signed with the literal placeholder must NOT verify —
      // it would if the real token above had actually been signed with
      // that same placeholder string. Strip `iss` from the decoded
      // claims first: jsonwebtoken's `sign()` rejects a payload that
      // already carries `iss` when `options.issuer` is also passed.
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      delete claims.iss;
      const forged = jwt.sign(claims, 'changeme', { issuer: 'crowi-mail-token', algorithm: 'HS256' });
      expect(forged).not.toBe(token);
      expect(createMailTokenUtil().verifyMailToken(forged, 'reset')).toBeNull();

      // The genuine token (signed with the random fallback secret) still
      // verifies normally.
      expect(createMailTokenUtil().verifyMailToken(token, 'reset')?.userId).toBe('victim-user-id');
    } finally {
      if (original === undefined) delete process.env.WS_TOKEN_SECRET;
      else process.env.WS_TOKEN_SECRET = original;
    }
  });
});
