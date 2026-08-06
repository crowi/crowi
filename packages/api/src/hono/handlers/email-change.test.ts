process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import request from 'supertest';
import { app, crowi, Fixture } from 'src/test/setup';
import type { UserDocument } from 'src/models/user';
import { createJwtUtil } from 'src/util/jwt';
import { createMailTokenUtil } from 'src/util/mail-token';

const jsonHeaders = { 'Content-Type': 'application/json' };

const createActiveUser = async (email: string): Promise<UserDocument> => {
  const User = crowi.model('User');
  const [user] = (await Fixture.generate('User', [{ name: 'EC', username: `ec_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, email }])) as UserDocument[];
  user.status = User.STATUS_ACTIVE;
  await user.save();
  return user;
};

/** Mint a change link exactly the way `PUT /me` does, bindings included. */
const changeTokenFor = (user: UserDocument, newEmail: string): string =>
  createMailTokenUtil().signMailToken({
    purpose: 'email-change',
    userId: user._id.toString(),
    email: newEmail,
    fromEmail: user.email,
    authVersion: user.authVersion ?? 0,
  }).token;

describe('Routes /api/auth/confirm-email-change (Hono)', () => {
  describe('GET (preflight)', () => {
    it('returns the new email for a valid token', async () => {
      const user = await createActiveUser('ec-old@example.com');
      const token = changeTokenFor(user, 'ec-new@example.com');
      const res = await request(app).get('/api/auth/confirm-email-change').query({ token });
      expect(res.status).toBe(200);
      expect(res.body.email).toBe('ec-new@example.com');
    });

    it('rejects a bad token with 401', async () => {
      const res = await request(app).get('/api/auth/confirm-email-change').query({ token: 'nope' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_EMAIL_CHANGE_TOKEN');
    });
  });

  describe('POST (apply)', () => {
    it('applies the new email address', async () => {
      const user = await createActiveUser('apply-old@example.com');
      const token = changeTokenFor(user, 'apply-new@example.com');

      const res = await request(app).post('/api/auth/confirm-email-change').set(jsonHeaders).send({ token });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, email: 'apply-new@example.com' });

      const reloaded = await crowi.model('User').findById(user._id);
      expect(reloaded?.email).toBe('apply-new@example.com');
    });

    it('rejects when the new email is already in use (409)', async () => {
      await createActiveUser('taken-target@example.com');
      const user = await createActiveUser('wants-taken@example.com');
      const token = changeTokenFor(user, 'taken-target@example.com');

      const res = await request(app).post('/api/auth/confirm-email-change').set(jsonHeaders).send({ token });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EMAIL_TAKEN');
    });

    it('rejects an invalid token with 401', async () => {
      const res = await request(app).post('/api/auth/confirm-email-change').set(jsonHeaders).send({ token: 'bogus' });
      expect(res.status).toBe(401);
    });

    it('rejects a token of the wrong purpose (reset) with 401', async () => {
      const user = await createActiveUser('wrongpurpose-ec@example.com');
      const resetToken = createMailTokenUtil().signMailToken({ purpose: 'reset', userId: user._id.toString(), email: 'x@example.com' }).token;
      const res = await request(app).post('/api/auth/confirm-email-change').set(jsonHeaders).send({ token: resetToken });
      expect(res.status).toBe(401);
    });

    it('dies with the session that requested it (a revocation event kills a pending change)', async () => {
      // The worst case this closes: an attacker holding a stolen session
      // requests a change to an address they control, keeps the 24h link,
      // and waits. The password is then reset *because* the account is
      // compromised — which strands the attacker's session but leaves
      // `email` untouched, so `fromEmail` still matches. Without a binding
      // to `authVersion` the attacker can still confirm afterwards and take
      // the recovery address, undoing the recovery itself.
      //
      // Driven end-to-end on purpose: the token comes from the real issuer
      // (PUT /me, captured off the mailer) and the revocation from a real
      // password change, not a hand-minted claim and a hand-rolled $inc.
      // Otherwise this would only test the confirm handler, and would still
      // pass if the issuer stopped binding the token or the password change
      // stopped advancing the version — the two halves that make it work.
      const User = crowi.model('User');
      const OWNER = 'evict-pending@example.com';
      const username = `ec_evict_${Date.now()}`;
      await User.deleteMany({ $or: [{ email: OWNER }, { username }] });
      const { user, accessToken } = await new Promise<{ user: UserDocument; accessToken: string }>((resolve, reject) => {
        User.createUserByEmailAndPassword('EC Evict', username, OWNER, 'Password!1', 'en', async (err: Error | null, created: UserDocument) => {
          if (err) return reject(err);
          created.status = User.STATUS_ACTIVE;
          await created.save();
          resolve({ user: created, accessToken: createJwtUtil(crowi).generateTokens(created).accessToken });
        });
      });

      let confirmUrl = '';
      const sendSpy = jest.spyOn(crowi.getMailer(), 'send').mockImplementation(async (opts: { vars?: Record<string, unknown> }) => {
        if (typeof opts?.vars?.confirmUrl === 'string') confirmUrl = opts.vars.confirmUrl;
      });

      try {
        const requested = await request(app)
          .put('/api/me')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ userForm: { name: 'EC Evict', email: 'attacker@example.com', lang: 'en' } });
        expect(requested.status).toBe(200);
        expect(requested.body.emailChangePending).toBe(true);

        // The mail send is fire-and-forget, so poll for the spy rather than
        // assuming it already ran.
        for (let i = 0; i < 50 && confirmUrl === ''; i++) await new Promise((r) => setImmediate(r));
        const pending = new URL(confirmUrl).searchParams.get('token') as string;
        expect(pending).toBeTruthy();

        // The link is live right up until the revocation event.
        const before = await request(app).get('/api/auth/confirm-email-change').query({ token: pending });
        expect(before.status).toBe(200);

        const changed = await request(app)
          .put('/api/me/password')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ oldPassword: 'Password!1', newPassword: 'NewPwd!2', newPasswordConfirm: 'NewPwd!2' });
        expect(changed.status).toBe(200);

        // Both the preflight and the apply now refuse it.
        const afterGet = await request(app).get('/api/auth/confirm-email-change').query({ token: pending });
        expect(afterGet.status).toBe(401);
        const afterPost = await request(app).post('/api/auth/confirm-email-change').set(jsonHeaders).send({ token: pending });
        expect(afterPost.status).toBe(401);

        const reloaded = await User.findById(user._id);
        expect(reloaded?.email).toBe(OWNER);
      } finally {
        sendSpy.mockRestore();
      }
    });

    it('is single-use: a token bound to the old email is rejected after the address changes (no revert replay)', async () => {
      const user = await createActiveUser('su-a@example.com');
      // Token bound to the current address (fromEmail) targeting B.
      const tokenAtoB = createMailTokenUtil().signMailToken({
        purpose: 'email-change',
        userId: user._id.toString(),
        email: 'su-b@example.com',
        fromEmail: 'su-a@example.com',
        // Otherwise valid — this test is about `fromEmail` going stale, so
        // the session binding has to hold or we would not reach that check.
        authVersion: user.authVersion ?? 0,
      }).token;
      // Apply A -> B.
      const apply = await request(app).post('/api/auth/confirm-email-change').set(jsonHeaders).send({ token: tokenAtoB });
      expect(apply.status).toBe(200);

      // Replaying the same (now stale) token must NOT revert B -> ... ;
      // fromEmail no longer matches the current address.
      const replay = await request(app).post('/api/auth/confirm-email-change').set(jsonHeaders).send({ token: tokenAtoB });
      expect(replay.status).toBe(401);

      const reloaded = await crowi.model('User').findById(user._id);
      expect(reloaded?.email).toBe('su-b@example.com');
    });

    it('is superseded: requesting a newer change invalidates the link still pending', async () => {
      // Without this, a leaked or attacker-initiated pending change cannot be
      // called off: asking for a different address does not disturb the older
      // link, because neither of the two bindings it carries (`fromEmail` and
      // `authVersion`) moves when a request is merely issued.
      const user = await createActiveUser('sup-old@example.com');
      const accessToken = createJwtUtil(crowi).generateTokens(user).accessToken;
      const attackerLink = changeTokenFor(user, 'sup-attacker@example.com');

      const second = await request(app)
        .put('/api/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ userForm: { name: user.name, email: 'sup-owner@example.com', lang: user.lang ?? 'en' } });
      expect(second.status).toBe(200);

      const replay = await request(app).post('/api/auth/confirm-email-change').set(jsonHeaders).send({ token: attackerLink });
      expect(replay.status).toBe(401);

      const reloaded = await crowi.model('User').findById(user._id);
      expect(reloaded?.email).toBe('sup-old@example.com');
    });

    it('a request admitted under a since-revoked session does not strand the pending link', async () => {
      // The doomed request cannot produce a confirmable link anyway (its
      // authVersion is stale). If it still burned the generation it would
      // take the legitimate pending change down with it.
      const User = crowi.model('User');
      const user = await createActiveUser('revoked-old@example.com');
      const accessToken = createJwtUtil(crowi).generateTokens(user).accessToken;
      const legitimateLink = changeTokenFor(user, 'revoked-wanted@example.com');

      // Revoke every session minted so far, exactly as a password change does.
      await User.findByIdAndUpdate(user._id, { $inc: { authVersion: 1 } });

      const doomed = await request(app)
        .put('/api/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ userForm: { name: user.name, email: 'revoked-attacker@example.com', lang: user.lang ?? 'en' } });
      expect([200, 401]).toContain(doomed.status);

      const stored = await User.findById(user._id);
      expect(stored?.emailChangeGeneration ?? 0).toBe(0);
      // The legitimate link is still the current generation; only its
      // authVersion binding (moved by the revocation) decides its fate.
      expect(legitimateLink).toBeTruthy();
    });

    it('cannot be confirmed while the account is suspended', async () => {
      // Suspending is how an operator cuts an account off. A confirmation
      // minted beforehand must not still be able to move the address the
      // account recovers through while it is locked out.
      const User = crowi.model('User');
      const user = await createActiveUser('susp-old@example.com');
      const link = changeTokenFor(user, 'susp-new@example.com');

      user.status = User.STATUS_SUSPENDED;
      await user.save();

      const res = await request(app).post('/api/auth/confirm-email-change').set(jsonHeaders).send({ token: link });
      expect(res.status).toBe(401);

      const reloaded = await User.findById(user._id);
      expect(reloaded?.email).toBe('susp-old@example.com');
    });

    it('preflight also refuses a suspended account', async () => {
      const User = crowi.model('User');
      const user = await createActiveUser('susp-pre@example.com');
      const link = changeTokenFor(user, 'susp-pre-new@example.com');

      user.status = User.STATUS_SUSPENDED;
      await user.save();

      const res = await request(app).get('/api/auth/confirm-email-change').query({ token: link });
      expect(res.status).toBe(401);
    });
  });
});
