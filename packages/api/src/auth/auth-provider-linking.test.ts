process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import faker from 'faker';
import { createAuthProviderLinkingTerminal, resolveAuthProviderLinkReplay, unlinkFederatedIdentity } from 'src/auth/auth-provider-linking';
import type { UserDocument } from 'src/models/user';
import { crowi, Fixture, randomUsername } from 'src/test/setup';

/**
 * DB-integration tests for linking a
 * provider account to an already-signed-in user, unlinking it again, and
 * re-deriving the outcome an already-consumed completion-code replay must
 * report.
 *
 * The route-level halves (link-start / callback / confirmation GET / final
 * POST) live in `hono/handlers/federated-auth.test.ts` — these cover the
 * DB-level primitives underneath them.
 */
describe('auth provider linking (3-stage link flow)', () => {
  const UserIdentity = () => crowi.model('UserIdentity');
  const Config = () => crowi.model('Config');

  const seedUser = async (): Promise<UserDocument> => {
    const [user] = (await Fixture.generate('User', [
      { name: faker.name.findName(), username: randomUsername(), email: faker.internet.email() },
    ])) as UserDocument[];
    return user;
  };

  describe('linking terminal', () => {
    it('links a fresh identity to the target user', async () => {
      const user = await seedUser();
      const terminal = createAuthProviderLinkingTerminal(crowi);

      expect(await terminal.link({ userId: user._id.toString(), provider: 'link-p1', providerUserId: 'sub-fresh' })).toEqual({ kind: 'linked' });
      expect(await UserIdentity().countDocuments({ provider: 'link-p1', providerUserId: 'sub-fresh' })).toBe(1);
    });

    it('re-linking the SAME account to the SAME user is a success no-op, not an error — and creates no second row', async () => {
      const user = await seedUser();
      const terminal = createAuthProviderLinkingTerminal(crowi);

      await terminal.link({ userId: user._id.toString(), provider: 'link-p2', providerUserId: 'sub-same' });
      const second = await terminal.link({ userId: user._id.toString(), provider: 'link-p2', providerUserId: 'sub-same' });

      expect(second).toEqual({ kind: 'already_linked_here' });
      expect(await UserIdentity().countDocuments({ provider: 'link-p2', providerUserId: 'sub-same' })).toBe(1);
    });

    it('an account already linked to ANOTHER user is refused without moving it, and without naming the owner', async () => {
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

    it('design decision 16: a same-subject row landing BETWEEN the exact-subject read and the slot read resolves to already_linked_here, not provider_slot_taken', async () => {
      const user = await seedUser();
      const provider = 'link-interleave';
      const providerUserId = 'sub-interleave';
      const terminal = createAuthProviderLinkingTerminal(crowi);
      const UserIdentityModel = UserIdentity();

      // Simulate: our own insert collided (as a concurrent writer already
      // won), the exact-subject read genuinely still sees nothing (it ran
      // BEFORE the interleaving insert lands), and then — as a side effect
      // of that first read — the SAME subject's row lands for real before
      // the terminal's own slot read runs.
      const createSpy = jest.spyOn(UserIdentityModel, 'create').mockImplementationOnce(async () => {
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      });
      const originalFindOne = UserIdentityModel.findOne.bind(UserIdentityModel);
      let findOneCalls = 0;
      const findOneSpy = jest.spyOn(UserIdentityModel, 'findOne').mockImplementation(async (...args: Parameters<typeof originalFindOne>) => {
        findOneCalls += 1;
        if (findOneCalls === 1) {
          // The exact-subject read (query 1: {provider, providerUserId}).
          const result = await originalFindOne(...args);
          // The interleaving insert lands strictly AFTER this read.
          await UserIdentityModel.collection.insertOne({ userId: user._id, provider, providerUserId });
          return result;
        }
        return originalFindOne(...args);
      });

      try {
        const outcome = await terminal.link({ userId: user._id.toString(), provider, providerUserId });
        expect(outcome).toEqual({ kind: 'already_linked_here' });
        expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(1);
      } finally {
        createSpy.mockRestore();
        findOneSpy.mockRestore();
      }
    });
  });

  describe('resolveAuthProviderLinkReplay', () => {
    it('exact subject, same owner as the record -> linked', async () => {
      const user = await seedUser();
      await UserIdentity().create({ userId: user._id, provider: 'replay-p1', providerUserId: 'sub-1' });

      expect(await resolveAuthProviderLinkReplay(crowi, { userId: user._id.toString(), provider: 'replay-p1', providerUserId: 'sub-1' })).toEqual({
        kind: 'linked',
      });
    });

    it('exact subject, DIFFERENT owner than the record -> owned_by_other_user', async () => {
      const owner = await seedUser();
      const other = await seedUser();
      await UserIdentity().create({ userId: owner._id, provider: 'replay-p2', providerUserId: 'sub-2' });

      expect(await resolveAuthProviderLinkReplay(crowi, { userId: other._id.toString(), provider: 'replay-p2', providerUserId: 'sub-2' })).toEqual({
        kind: 'owned_by_other_user',
      });
    });

    it('exact subject absent, provider slot present with the SAME providerUserId (the original insert landed between the two reads) -> linked', async () => {
      const user = await seedUser();
      const provider = 'replay-p3';
      const providerUserId = 'sub-3';
      const UserIdentityModel = UserIdentity();

      // Force the SAME interleave design decision 16/17 exist for: the
      // exact-subject read genuinely finds nothing (runs BEFORE the
      // insert lands), and the row lands for real strictly between that
      // read and the provider-slot read.
      const originalFindOne = UserIdentityModel.findOne.bind(UserIdentityModel);
      let findOneCalls = 0;
      const findOneSpy = jest.spyOn(UserIdentityModel, 'findOne').mockImplementation(async (...args: Parameters<typeof originalFindOne>) => {
        findOneCalls += 1;
        if (findOneCalls === 1) {
          const result = await originalFindOne(...args);
          await UserIdentityModel.collection.insertOne({ userId: user._id, provider, providerUserId });
          return result;
        }
        return originalFindOne(...args);
      });

      try {
        expect(await resolveAuthProviderLinkReplay(crowi, { userId: user._id.toString(), provider, providerUserId })).toEqual({
          kind: 'linked',
        });
      } finally {
        findOneSpy.mockRestore();
      }
    });

    it('exact subject absent, provider slot present with a DIFFERENT providerUserId -> provider_slot_taken', async () => {
      const user = await seedUser();
      await UserIdentity().create({ userId: user._id, provider: 'replay-p4', providerUserId: 'sub-other' });

      expect(await resolveAuthProviderLinkReplay(crowi, { userId: user._id.toString(), provider: 'replay-p4', providerUserId: 'sub-4' })).toEqual({
        kind: 'provider_slot_taken',
      });
    });

    it('no row at all (original insert never landed, or landed and was later removed) -> not_linked', async () => {
      const user = await seedUser();
      expect(await resolveAuthProviderLinkReplay(crowi, { userId: user._id.toString(), provider: 'replay-p5', providerUserId: 'sub-5' })).toEqual({
        kind: 'not_linked',
      });
    });

    it('provider slug alone never decides success — a different subject under the same provider slug is a conflict, not linked', async () => {
      const user = await seedUser();
      await UserIdentity().create({ userId: user._id, provider: 'replay-p6', providerUserId: 'sub-real' });

      const replay = await resolveAuthProviderLinkReplay(crowi, { userId: user._id.toString(), provider: 'replay-p6', providerUserId: 'sub-impersonated' });
      expect(replay).toEqual({ kind: 'provider_slot_taken' });

      const terminal = createAuthProviderLinkingTerminal(crowi);
      const terminalOutcome = await terminal.link({ userId: user._id.toString(), provider: 'replay-p6', providerUserId: 'sub-impersonated' });
      expect(terminalOutcome).toEqual({ kind: 'provider_slot_taken' });
    });
  });

  describe('unlink guard', () => {
    const setDisablePasswordAuth = async (value: boolean) => {
      await Config().updateConfig('crowi', 'auth:disablePasswordAuth', value);
      await crowi.getConfigService().load();
    };

    afterEach(async () => {
      await setDisablePasswordAuth(false);
    });

    it('refuses while password auth is disabled instance-wide, and leaves the identity in place', async () => {
      const user = await seedUser();
      await UserIdentity().create({ userId: user._id, provider: 'unlink-p1', providerUserId: 'sub-1' });
      await setDisablePasswordAuth(true);

      expect(await unlinkFederatedIdentity(crowi, user, 'unlink-p1')).toEqual({ kind: 'password_auth_disabled' });
      expect(await UserIdentity().countDocuments({ userId: user._id, provider: 'unlink-p1' })).toBe(1);
    });

    it('refuses when the user has no password set, and leaves the identity in place', async () => {
      const user = await seedUser();
      await UserIdentity().create({ userId: user._id, provider: 'unlink-p2', providerUserId: 'sub-2' });
      // `Fixture.generate('User')` creates no password — exactly the
      // federated-only account this guard exists for.
      expect((await user.populateSecrets()).isPasswordSet()).toBe(false);

      expect(await unlinkFederatedIdentity(crowi, user, 'unlink-p2')).toEqual({ kind: 'password_required' });
      expect(await UserIdentity().countDocuments({ userId: user._id, provider: 'unlink-p2' })).toBe(1);
    });

    it('removes the identity once a password exists', async () => {
      const user = await seedUser();
      await user.setPassword('Password!1');
      await user.save();
      await UserIdentity().create({ userId: user._id, provider: 'unlink-p3', providerUserId: 'sub-3' });

      expect(await unlinkFederatedIdentity(crowi, user, 'unlink-p3')).toEqual({ kind: 'unlinked' });
      expect(await UserIdentity().countDocuments({ userId: user._id, provider: 'unlink-p3' })).toBe(0);
    });

    it('reports not_linked (never a false success) for a provider this user never connected', async () => {
      const user = await seedUser();
      await user.setPassword('Password!1');
      await user.save();

      expect(await unlinkFederatedIdentity(crowi, user, 'unlink-never')).toEqual({ kind: 'not_linked' });
    });

    it('the guard never counts identities — unlinking the ONLY identity succeeds as long as a password remains', async () => {
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

  describe('link / unlink concurrency', () => {
    it('concurrent link + unlink of the same identity settle on ONE state consistent with the write order, never a duplicate', async () => {
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

    it('two concurrent links of the same account by DIFFERENT users never both succeed and never transfer ownership', async () => {
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
