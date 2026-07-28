process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import request from 'supertest';
import { app, crowi, Fixture } from 'src/test/setup';
import type { UserDocument } from 'src/models/user';
import { createJwtUtil } from 'src/util/jwt';
import { createMailTokenUtil } from 'src/util/mail-token';

const jsonHeaders = { 'Content-Type': 'application/json' };

const createActiveUser = async (email: string): Promise<UserDocument> => {
  const User = crowi.model('User');
  const [user] = (await Fixture.generate('User', [
    { name: 'PW User', username: `pw_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, email },
  ])) as UserDocument[];
  user.status = User.STATUS_ACTIVE;
  user.setPassword('original-password');
  await user.save();
  return user;
};

/**
 * Mint a reset link exactly the way `forgot-password` does — including the
 * `resetGeneration` binding that makes it single-use.
 */
const resetTokenFor = (user: UserDocument, email: string): string =>
  createMailTokenUtil().signMailToken({
    purpose: 'reset',
    userId: user._id.toString(),
    email,
    resetGeneration: user.passwordResetGeneration ?? 0,
  }).token;

describe('Routes /api/v2/auth password reset (Hono)', () => {
  describe('POST /api/v2/auth/forgot-password', () => {
    it('returns 200 for an existing account', async () => {
      await createActiveUser('exists@example.com');
      const res = await request(app).post('/api/v2/auth/forgot-password').set(jsonHeaders).send({ email: 'exists@example.com' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('returns 200 for an unknown account (anti-enumeration)', async () => {
      const res = await request(app).post('/api/v2/auth/forgot-password').set(jsonHeaders).send({ email: 'nobody@example.com' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });
  });

  describe('GET /api/v2/auth/reset-password', () => {
    it('validates a good token', async () => {
      const user = await createActiveUser('validate@example.com');
      const token = resetTokenFor(user, 'validate@example.com');
      const res = await request(app).get('/api/v2/auth/reset-password').query({ token });
      expect(res.status).toBe(200);
    });

    it('rejects a bad token with 401', async () => {
      const res = await request(app).get('/api/v2/auth/reset-password').query({ token: 'nope' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_RESET_TOKEN');
    });
  });

  describe('POST /api/v2/auth/reset-password', () => {
    it('sets a new password and signs the user in', async () => {
      const user = await createActiveUser('reset@example.com');
      const token = resetTokenFor(user, 'reset@example.com');

      const res = await request(app).post('/api/v2/auth/reset-password').set(jsonHeaders).send({ token, password: 'brand-new-pw' });
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeTruthy();
      expect(res.body.refreshToken).toBeTruthy();

      // The stored password is the new one (password is select:false).
      const User = crowi.model('User');
      const reloaded = await User.findById(user._id).select('+password');
      expect(reloaded?.isPasswordValid('brand-new-pw')).toBe(true);
      expect(reloaded?.isPasswordValid('original-password')).toBe(false);
    });

    it('rejects an invalid token with 401', async () => {
      const res = await request(app).post('/api/v2/auth/reset-password').set(jsonHeaders).send({ token: 'bogus', password: 'whatever123' });
      expect(res.status).toBe(401);
    });

    it('is single-use: the same token cannot be replayed', async () => {
      const user = await createActiveUser('replay@example.com');
      const token = resetTokenFor(user, 'replay@example.com');

      const first = await request(app).post('/api/v2/auth/reset-password').set(jsonHeaders).send({ token, password: 'owner-chosen-pw' });
      expect(first.status).toBe(200);

      // Same token, still inside its 1h TTL: whoever got hold of the link
      // afterwards must not be able to take the account over.
      const second = await request(app).post('/api/v2/auth/reset-password').set(jsonHeaders).send({ token, password: 'attacker-pw' });
      expect(second.status).toBe(401);
      expect(second.body.accessToken).toBeUndefined();

      const User = crowi.model('User');
      const reloaded = await User.findById(user._id).select('+password');
      expect(reloaded?.isPasswordValid('owner-chosen-pw')).toBe(true);
      expect(reloaded?.isPasswordValid('attacker-pw')).toBe(false);
    });

    it('evicts sessions that existed before the reset', async () => {
      // A reset is the "I have lost control of this account" door, so it has
      // to strand whoever else is already holding a session — otherwise the
      // owner regains their password while the attacker keeps their access.
      const user = await createActiveUser('evict@example.com');
      const jwtUtil = createJwtUtil(crowi);
      const attackerToken = jwtUtil.generateTokens(user).accessToken;

      // The attacker's token works right up until the reset.
      const before = await request(app)
        .get('/api/v2/me')
        .set({ Authorization: `Bearer ${attackerToken}` });
      expect(before.status).toBe(200);

      const token = resetTokenFor(user, 'evict@example.com');
      const reset = await request(app).post('/api/v2/auth/reset-password').set(jsonHeaders).send({ token, password: 'owner-regained-pw' });
      expect(reset.status).toBe(200);

      const after = await request(app)
        .get('/api/v2/me')
        .set({ Authorization: `Bearer ${attackerToken}` });
      expect(after.status).toBe(401);

      // ...while the pair minted by the reset itself is usable.
      const fresh = await request(app)
        .get('/api/v2/me')
        .set({ Authorization: `Bearer ${reset.body.accessToken}` });
      expect(fresh.status).toBe(200);
    });

    it('rejects a token of the wrong purpose (invite token) with 401', async () => {
      const user = await createActiveUser('wrongpurpose@example.com');
      const inviteToken = createMailTokenUtil().signMailToken({ purpose: 'invite', userId: user._id.toString(), email: 'wrongpurpose@example.com' }).token;
      const res = await request(app).post('/api/v2/auth/reset-password').set(jsonHeaders).send({ token: inviteToken, password: 'whatever123' });
      expect(res.status).toBe(401);
    });
  });
});
