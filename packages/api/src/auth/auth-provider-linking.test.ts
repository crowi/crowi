process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import faker from 'faker';
import { createAuthProviderLinkingTerminal, createLinkGrantStore, unlinkFederatedIdentity } from 'src/auth/auth-provider-linking';
import type { UserDocument } from 'src/models/user';
import { crowi, Fixture, randomUsername } from 'src/test/setup';

/**
 * RFC-0014 phase 3 — DB-integration tests for linking a provider account to
 * an already signed-in user (AC-2, AC-4, AC-5, AC-6).
 *
 * The route-level halves (AC-1 protected start, AC-3 callback branch, AC-7
 * handoff identity fence) live in
 * `hono/handlers/federated-auth.test.ts` — these cover the primitives
 * underneath them.
 */
describe('auth provider linking (RFC-0014 phase 3)', () => {
  const UserIdentity = () => crowi.model('UserIdentity');
  const Config = () => crowi.model('Config');

  const seedUser = async (): Promise<UserDocument> => {
    const [user] = (await Fixture.generate('User', [
      { name: faker.name.findName(), username: randomUsername(), email: faker.internet.email() },
    ])) as UserDocument[];
    return user;
  };

  describe('link grant binding (AC-2)', () => {
    it('round-trips a grant and consumes it exactly once — a replayed id is rejected like an unknown one', async () => {
      const store = createLinkGrantStore();
      const grant = { userId: 'user-1', provider: 'google', authVersion: 3, handoffChallenge: 'jkt-victim' };

      const grantId = await store.issue(grant);
      expect(await store.consume(grantId)).toEqual(grant);
      // Single-use: an attacker who intercepted the `/start` URL cannot
      // replay its grant behind the legitimate navigation.
      expect(await store.consume(grantId)).toBeNull();
    });

    it('returns null for an unknown grant id — indistinguishable from a consumed or expired one', async () => {
      const store = createLinkGrantStore();
      expect(await store.consume('never-issued')).toBeNull();
    });

    it('expires a grant that outlived its 30s window', async () => {
      jest.useFakeTimers();
      try {
        const store = createLinkGrantStore();
        const grantId = await store.issue({ userId: 'user-1', provider: 'google', authVersion: 0, handoffChallenge: 'jkt' });
        jest.advanceTimersByTime(30_001);
        expect(await store.consume(grantId)).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it("AC-2: the consumed grant carries the VICTIM's subject/authVersion/sender key — the values `/start` compares against, so an attacker's own JWT and sender key cannot satisfy it", async () => {
      const store = createLinkGrantStore();
      const victim = { userId: 'victim-id', provider: 'google', authVersion: 7, handoffChallenge: 'jkt-victim-browser' };
      const grantId = await store.issue(victim);

      const consumed = await store.consume(grantId);
      // Every one of these is a value the attacker would have to match: a
      // different signed-in user (`userId`), a session invalidated since
      // (`authVersion`), or — the decisive one for a stolen link URL — a
      // different browser's sender key (`handoffChallenge`).
      expect(consumed?.userId).toBe('victim-id');
      expect(consumed?.authVersion).toBe(7);
      expect(consumed?.handoffChallenge).toBe('jkt-victim-browser');
      expect(consumed?.provider).toBe('google');
    });
  });

  describe('linking terminal (AC-4)', () => {
    it('links a fresh identity to the target user', async () => {
      const user = await seedUser();
      const terminal = createAuthProviderLinkingTerminal(crowi);

      expect(await terminal.link({ userId: user._id.toString(), provider: 'link-p1', providerUserId: 'sub-fresh' })).toEqual({ kind: 'linked' });
      expect(await UserIdentity().countDocuments({ provider: 'link-p1', providerUserId: 'sub-fresh' })).toBe(1);
    });

    it('AC-4: re-linking the SAME account to the SAME user is a success no-op, not an error — and creates no second row', async () => {
      const user = await seedUser();
      const terminal = createAuthProviderLinkingTerminal(crowi);

      await terminal.link({ userId: user._id.toString(), provider: 'link-p2', providerUserId: 'sub-same' });
      const second = await terminal.link({ userId: user._id.toString(), provider: 'link-p2', providerUserId: 'sub-same' });

      expect(second).toEqual({ kind: 'already_linked_here' });
      expect(await UserIdentity().countDocuments({ provider: 'link-p2', providerUserId: 'sub-same' })).toBe(1);
    });

    it('AC-4: an account already linked to ANOTHER user is refused without moving it, and without naming the owner', async () => {
      const owner = await seedUser();
      const attacker = await seedUser();
      const terminal = createAuthProviderLinkingTerminal(crowi);

      await terminal.link({ userId: owner._id.toString(), provider: 'link-p3', providerUserId: 'sub-owned' });
      const stolen = await terminal.link({ userId: attacker._id.toString(), provider: 'link-p3', providerUserId: 'sub-owned' });

      // The outcome names no user — the caller cannot use this endpoint to
      // learn who holds a given provider account.
      expect(stolen).toEqual({ kind: 'owned_by_other_user' });

      // The identity did NOT move: still exactly one row, still the owner's.
      expect(await UserIdentity().countDocuments({ provider: 'link-p3', providerUserId: 'sub-owned' })).toBe(1);
      const row = await UserIdentity().findOne({ provider: 'link-p3', providerUserId: 'sub-owned' });
      expect(String(row?.userId)).toBe(String(owner._id));
    });

    it('refuses a SECOND account of the same provider for one user (the {userId, provider} unique index), leaving the first intact', async () => {
      const user = await seedUser();
      const terminal = createAuthProviderLinkingTerminal(crowi);

      await terminal.link({ userId: user._id.toString(), provider: 'link-p4', providerUserId: 'sub-first' });
      const second = await terminal.link({ userId: user._id.toString(), provider: 'link-p4', providerUserId: 'sub-second' });

      expect(second).toEqual({ kind: 'provider_slot_taken' });
      expect(await UserIdentity().countDocuments({ userId: user._id, provider: 'link-p4' })).toBe(1);
      const row = await UserIdentity().findOne({ userId: user._id, provider: 'link-p4' });
      expect(row?.providerUserId).toBe('sub-first');
    });
  });

  describe('unlink guard (AC-5)', () => {
    const setDisablePasswordAuth = async (value: boolean) => {
      await Config().updateConfig('crowi', 'auth:disablePasswordAuth', value);
      await crowi.getConfigService().load();
    };

    afterEach(async () => {
      await setDisablePasswordAuth(false);
    });

    it('AC-5: refuses while password auth is disabled instance-wide, and leaves the identity in place', async () => {
      const user = await seedUser();
      await UserIdentity().create({ userId: user._id, provider: 'unlink-p1', providerUserId: 'sub-1' });
      await setDisablePasswordAuth(true);

      expect(await unlinkFederatedIdentity(crowi, user, 'unlink-p1')).toEqual({ kind: 'password_auth_disabled' });
      expect(await UserIdentity().countDocuments({ userId: user._id, provider: 'unlink-p1' })).toBe(1);
    });

    it('AC-5: refuses when the user has no password set, and leaves the identity in place', async () => {
      const user = await seedUser();
      await UserIdentity().create({ userId: user._id, provider: 'unlink-p2', providerUserId: 'sub-2' });
      // `Fixture.generate('User')` creates no password — exactly the
      // federated-only account this guard exists for.
      expect((await user.populateSecrets()).isPasswordSet()).toBe(false);

      expect(await unlinkFederatedIdentity(crowi, user, 'unlink-p2')).toEqual({ kind: 'password_required' });
      expect(await UserIdentity().countDocuments({ userId: user._id, provider: 'unlink-p2' })).toBe(1);
    });

    it('AC-5: removes the identity once a password exists', async () => {
      const user = await seedUser();
      await user.setPassword('Password!1');
      await user.save();
      await UserIdentity().create({ userId: user._id, provider: 'unlink-p3', providerUserId: 'sub-3' });

      expect(await unlinkFederatedIdentity(crowi, user, 'unlink-p3')).toEqual({ kind: 'unlinked' });
      expect(await UserIdentity().countDocuments({ userId: user._id, provider: 'unlink-p3' })).toBe(0);
    });

    it('AC-5: reports not_linked (never a false success) for a provider this user never connected', async () => {
      const user = await seedUser();
      await user.setPassword('Password!1');
      await user.save();

      expect(await unlinkFederatedIdentity(crowi, user, 'unlink-never')).toEqual({ kind: 'not_linked' });
    });

    it('AC-5: the guard never counts identities — unlinking the ONLY identity succeeds as long as a password remains', async () => {
      const user = await seedUser();
      await user.setPassword('Password!1');
      await user.save();
      await UserIdentity().create({ userId: user._id, provider: 'unlink-only', providerUserId: 'sub-only' });
      expect(await UserIdentity().countDocuments({ userId: user._id })).toBe(1);

      // A count-based "don't remove the last login method" guard would
      // refuse here. The password-anchored guard correctly allows it: the
      // account still has a way in, which is the property that actually
      // matters (and, unlike a count, cannot be invalidated by a
      // concurrent unlink).
      expect(await unlinkFederatedIdentity(crowi, user, 'unlink-only')).toEqual({ kind: 'unlinked' });
      expect(await UserIdentity().countDocuments({ userId: user._id })).toBe(0);
    });
  });

  describe('link / unlink concurrency (AC-6)', () => {
    it('AC-6: concurrent link + unlink of the same identity settle on ONE state consistent with the write order, never a duplicate', async () => {
      const user = await seedUser();
      await user.setPassword('Password!1');
      await user.save();
      const terminal = createAuthProviderLinkingTerminal(crowi);
      await UserIdentity().create({ userId: user._id, provider: 'race-p1', providerUserId: 'sub-race' });

      const [linkOutcome, unlinkOutcome] = await Promise.all([
        terminal.link({ userId: user._id.toString(), provider: 'race-p1', providerUserId: 'sub-race' }),
        unlinkFederatedIdentity(crowi, user, 'race-p1'),
      ]);

      // Whichever landed last decides the final state, but the invariants
      // hold either way: never two rows, and the row (if any) is this
      // user's.
      const rows = await UserIdentity().find({ provider: 'race-p1', providerUserId: 'sub-race' });
      expect(rows.length).toBeLessThanOrEqual(1);
      if (rows.length === 1) expect(String(rows[0].userId)).toBe(String(user._id));
      expect(['linked', 'already_linked_here']).toContain(linkOutcome.kind);
      expect(['unlinked', 'not_linked']).toContain(unlinkOutcome.kind);
    });

    it('AC-6: two concurrent links of the same account by DIFFERENT users never both succeed and never transfer ownership', async () => {
      const first = await seedUser();
      const second = await seedUser();
      const terminal = createAuthProviderLinkingTerminal(crowi);

      const [a, b] = await Promise.all([
        terminal.link({ userId: first._id.toString(), provider: 'race-p2', providerUserId: 'sub-contested' }),
        terminal.link({ userId: second._id.toString(), provider: 'race-p2', providerUserId: 'sub-contested' }),
      ]);

      const outcomes = [a.kind, b.kind];
      expect(outcomes.filter((k) => k === 'linked')).toHaveLength(1);
      expect(outcomes.filter((k) => k === 'owned_by_other_user')).toHaveLength(1);

      // The unique index is the final defense: exactly one row, owned by
      // whichever user won, and never re-pointed at the loser.
      expect(await UserIdentity().countDocuments({ provider: 'race-p2', providerUserId: 'sub-contested' })).toBe(1);
      const row = await UserIdentity().findOne({ provider: 'race-p2', providerUserId: 'sub-contested' });
      const winner = a.kind === 'linked' ? first : second;
      expect(String(row?.userId)).toBe(String(winner._id));
    });
  });
});
