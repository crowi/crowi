process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import request from 'supertest';
import { app, crowi, Fixture } from 'src/test/setup';
import type { UserDocument } from 'src/models/user';
import { createMailTokenUtil } from 'src/util/mail-token';

const jsonHeaders = { 'Content-Type': 'application/json' };

/** A self-registered, email-unconfirmed (REGISTERED) user + activate token. */
const createUnconfirmedUser = async (email: string): Promise<{ user: UserDocument; token: string }> => {
  const User = crowi.model('User');
  const [user] = (await Fixture.generate('User', [
    { name: 'Pending', username: `pending_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, email },
  ])) as UserDocument[];
  user.status = User.STATUS_REGISTERED;
  user.emailConfirmedAt = null;
  await user.save();
  const { token } = createMailTokenUtil().signMailToken({ purpose: 'activate', userId: user._id.toString(), email });
  return { user, token };
};

describe('Routes /api/auth/activate (Hono)', () => {
  describe('GET /api/auth/activate', () => {
    it('validates a good activation token', async () => {
      const { token } = await createUnconfirmedUser('activate-validate@example.com');
      const res = await request(app).get('/api/auth/activate').query({ token });
      expect(res.status).toBe(200);
    });

    it('rejects a bad token with 401', async () => {
      const res = await request(app).get('/api/auth/activate').query({ token: 'nope' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_ACTIVATION_TOKEN');
    });
  });

  describe('POST /api/auth/activate', () => {
    it('confirms email, activates the account, and signs in', async () => {
      const { user, token } = await createUnconfirmedUser('activate@example.com');
      const User = crowi.model('User');

      const res = await request(app).post('/api/auth/activate').set(jsonHeaders).send({ token });
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeTruthy();
      expect(res.body.refreshToken).toBeTruthy();

      const reloaded = await User.findById(user._id);
      expect(reloaded?.status).toBe(User.STATUS_ACTIVE);
      expect(reloaded?.emailConfirmedAt).toBeTruthy();
    });

    it('rejects an invalid token with 401', async () => {
      const res = await request(app).post('/api/auth/activate').set(jsonHeaders).send({ token: 'bogus' });
      expect(res.status).toBe(401);
    });

    it('never signs in an already-active account (the link is not a login credential)', async () => {
      const { user, token } = await createUnconfirmedUser('activate-already-active@example.com');
      const User = crowi.model('User');
      // The first click already activated the account; the link stays
      // signature-valid for its full 24h TTL.
      user.status = User.STATUS_ACTIVE;
      user.emailConfirmedAt = new Date();
      await user.save();

      const res = await request(app).post('/api/auth/activate').set(jsonHeaders).send({ token });

      // A 24h-valid mail link must not mint a session for an account that
      // is already active — that would be a first-factor bypass.
      expect(res.status).toBe(401);
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.refreshToken).toBeUndefined();
    });

    it('rejects a token of the wrong purpose (reset token) with 401', async () => {
      const { user } = await createUnconfirmedUser('wrongpurpose-activate@example.com');
      const resetToken = createMailTokenUtil().signMailToken({
        purpose: 'reset',
        userId: user._id.toString(),
        email: 'wrongpurpose-activate@example.com',
      }).token;
      const res = await request(app).post('/api/auth/activate').set(jsonHeaders).send({ token: resetToken });
      expect(res.status).toBe(401);
    });
  });
});
