process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import request from 'supertest';
import { app, crowi, Fixture } from 'src/test/setup';
import type { UserDocument } from 'src/models/user';
import { createMailTokenUtil } from 'src/util/mail-token';

const jsonHeaders = { 'Content-Type': 'application/json' };

/** Create a STATUS_INVITED user (email only) + a valid invite token. */
const createInvitedUser = async (email: string): Promise<{ user: UserDocument; token: string }> => {
  const User = crowi.model('User');
  const [user] = (await Fixture.generate('User', [{ name: '', username: '', email }])) as UserDocument[];
  user.status = User.STATUS_INVITED;
  await user.save();
  const { token } = createMailTokenUtil().signMailToken({ purpose: 'invite', userId: user._id.toString(), email });
  return { user, token };
};

describe('Routes /api/v2/invite/accept (Hono)', () => {
  describe('GET /api/v2/invite/accept', () => {
    it('returns the invited email for a valid token', async () => {
      const { token } = await createInvitedUser('preview@example.com');
      const res = await request(app).get('/api/v2/invite/accept').query({ token });
      expect(res.status).toBe(200);
      expect(res.body.email).toBe('preview@example.com');
    });

    it('returns 401 for an invalid token', async () => {
      const res = await request(app).get('/api/v2/invite/accept').query({ token: 'not-a-token' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_INVITE_TOKEN');
    });
  });

  describe('POST /api/v2/invite/accept', () => {
    it('activates the account, signs in, and flips status to ACTIVE', async () => {
      const { user, token } = await createInvitedUser('accept@example.com');
      const User = crowi.model('User');

      const res = await request(app)
        .post('/api/v2/invite/accept')
        .set(jsonHeaders)
        .send({ token, username: 'accepted_user', name: 'Accepted User', password: 'secret123' });

      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeTruthy();
      expect(res.body.refreshToken).toBeTruthy();
      expect(res.body.user.username).toBe('accepted_user');

      const reloaded = await User.findById(user._id);
      expect(reloaded?.status).toBe(User.STATUS_ACTIVE);
      expect(reloaded?.name).toBe('Accepted User');
    });

    it('rejects an invalid / expired token with 401', async () => {
      const res = await request(app).post('/api/v2/invite/accept').set(jsonHeaders).send({ token: 'bogus', username: 'x', name: 'X', password: 'secret123' });
      expect(res.status).toBe(401);
    });

    it('rejects a token whose user is already accepted (409)', async () => {
      const { user, token } = await createInvitedUser('already@example.com');
      const User = crowi.model('User');
      user.status = User.STATUS_ACTIVE;
      await user.save();

      const res = await request(app)
        .post('/api/v2/invite/accept')
        .set(jsonHeaders)
        .send({ token, username: 'already_user', name: 'Already', password: 'secret123' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVITE_ALREADY_ACCEPTED');
    });

    it('rejects a username already taken by another user (409)', async () => {
      const User = crowi.model('User');
      const [existing] = (await Fixture.generate('User', [{ name: 'Taken', username: 'taken_name', email: 'taken@example.com' }])) as UserDocument[];
      existing.status = User.STATUS_ACTIVE;
      await existing.save();

      const { token } = await createInvitedUser('wantstaken@example.com');
      const res = await request(app)
        .post('/api/v2/invite/accept')
        .set(jsonHeaders)
        .send({ token, username: 'taken_name', name: 'Wants', password: 'secret123' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('USERNAME_TAKEN');
    });
  });
});
