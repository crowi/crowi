process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import request from 'supertest';
import { app, crowi, Fixture } from 'src/test/setup';
import type { UserDocument } from 'src/models/user';
import { createMailTokenUtil } from 'src/util/mail-token';

const jsonHeaders = { 'Content-Type': 'application/json' };

const createActiveUser = async (email: string): Promise<UserDocument> => {
  const User = crowi.model('User');
  const [user] = (await Fixture.generate('User', [{ name: 'EC', username: `ec_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, email }])) as UserDocument[];
  user.status = User.STATUS_ACTIVE;
  await user.save();
  return user;
};

const changeTokenFor = (user: UserDocument, newEmail: string): string =>
  createMailTokenUtil().signMailToken({ purpose: 'email-change', userId: user._id.toString(), email: newEmail }).token;

describe('Routes /api/v2/auth/confirm-email-change (Hono)', () => {
  describe('GET (preflight)', () => {
    it('returns the new email for a valid token', async () => {
      const user = await createActiveUser('ec-old@example.com');
      const token = changeTokenFor(user, 'ec-new@example.com');
      const res = await request(app).get('/api/v2/auth/confirm-email-change').query({ token });
      expect(res.status).toBe(200);
      expect(res.body.email).toBe('ec-new@example.com');
    });

    it('rejects a bad token with 401', async () => {
      const res = await request(app).get('/api/v2/auth/confirm-email-change').query({ token: 'nope' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_EMAIL_CHANGE_TOKEN');
    });
  });

  describe('POST (apply)', () => {
    it('applies the new email address', async () => {
      const user = await createActiveUser('apply-old@example.com');
      const token = changeTokenFor(user, 'apply-new@example.com');

      const res = await request(app).post('/api/v2/auth/confirm-email-change').set(jsonHeaders).send({ token });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, email: 'apply-new@example.com' });

      const reloaded = await crowi.model('User').findById(user._id);
      expect(reloaded?.email).toBe('apply-new@example.com');
    });

    it('rejects when the new email is already in use (409)', async () => {
      await createActiveUser('taken-target@example.com');
      const user = await createActiveUser('wants-taken@example.com');
      const token = changeTokenFor(user, 'taken-target@example.com');

      const res = await request(app).post('/api/v2/auth/confirm-email-change').set(jsonHeaders).send({ token });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EMAIL_TAKEN');
    });

    it('rejects an invalid token with 401', async () => {
      const res = await request(app).post('/api/v2/auth/confirm-email-change').set(jsonHeaders).send({ token: 'bogus' });
      expect(res.status).toBe(401);
    });

    it('rejects a token of the wrong purpose (reset) with 401', async () => {
      const user = await createActiveUser('wrongpurpose-ec@example.com');
      const resetToken = createMailTokenUtil().signMailToken({ purpose: 'reset', userId: user._id.toString(), email: 'x@example.com' }).token;
      const res = await request(app).post('/api/v2/auth/confirm-email-change').set(jsonHeaders).send({ token: resetToken });
      expect(res.status).toBe(401);
    });

    it('is single-use: a token bound to the old email is rejected after the address changes (no revert replay)', async () => {
      const user = await createActiveUser('su-a@example.com');
      // Token bound to the current address (fromEmail) targeting B.
      const tokenAtoB = createMailTokenUtil().signMailToken({
        purpose: 'email-change',
        userId: user._id.toString(),
        email: 'su-b@example.com',
        fromEmail: 'su-a@example.com',
      }).token;
      // Apply A -> B.
      const apply = await request(app).post('/api/v2/auth/confirm-email-change').set(jsonHeaders).send({ token: tokenAtoB });
      expect(apply.status).toBe(200);

      // Replaying the same (now stale) token must NOT revert B -> ... ;
      // fromEmail no longer matches the current address.
      const replay = await request(app).post('/api/v2/auth/confirm-email-change').set(jsonHeaders).send({ token: tokenAtoB });
      expect(replay.status).toBe(401);

      const reloaded = await crowi.model('User').findById(user._id);
      expect(reloaded?.email).toBe('su-b@example.com');
    });
  });
});
