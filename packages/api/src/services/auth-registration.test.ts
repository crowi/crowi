process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import faker from 'faker';
import { Types } from 'mongoose';
import type { UserDocument } from 'src/models/user';
import { createAuthRegistrationTerminal, drainUserActivation, provisionPendingRegistration } from 'src/services/auth-registration';
import { crowi, Fixture, randomUsername } from 'src/test/setup';

/**
 * RFC-0014 phase 2 — model-integration tests for the JIT-registration
 * resume state machine (design decision 3) and the durable
 * activation-marker drain (design decision 4). AC-5 / AC-6 / AC-7.
 */
describe('provisionPendingRegistration / drainUserActivation (RFC-0014 phase 2)', () => {
  const User = () => crowi.model('User');
  const UserIdentity = () => crowi.model('UserIdentity');
  const PendingAuthRegistration = () => crowi.model('PendingAuthRegistration');
  const UserActivation = () => crowi.model('UserActivation');
  const Page = () => crowi.model('Page');
  const Config = () => crowi.model('Config');

  /** RFC 7638 JWK thumbprint of the "original /start sender key" — a fixed opaque test value, never parsed, just persisted/compared byte-for-byte. */
  const TEST_HANDOFF_JKT = 'test-handoff-jkt';

  /** `createAuthRegistrationTerminal(crowi).resolve(...)` with the fixed `providerLabel`/`handoffJkt` every call site in this file uses — mirrors `federated-registration.test.ts#resolveUnknownProfile`. */
  const resolveProfile = (provider: string, providerUserId: string, email: string) =>
    createAuthRegistrationTerminal(crowi).resolve({ provider, profile: { providerUserId, email }, providerLabel: 'Google', handoffJkt: TEST_HANDOFF_JKT });

  const seedGrant = async (provider: string, providerUserId: string, email: string) => {
    const result = await resolveProfile(provider, providerUserId, email);
    if (result.kind !== 'registration') throw new Error(`expected a registration outcome, got ${result.kind}`);
    return result.token;
  };

  /**
   * Test-only fixture helper: flips PENDING -> PROVISIONING via the real CAS
   * (`beginProvisioning`), then immediately releases the AC-7 single-flight
   * lease it claims. These tests want a resumable "row is already
   * PROVISIONING" fixture for their OWN manual state-seeding, not to
   * simulate an actual in-flight concurrent caller (which would need to
   * keep holding the lease) — using the raw model method directly here
   * would leave the lease held for its full 30s, making the SUBSEQUENT
   * `provisionPendingRegistration(...)` call under test spuriously observe
   * a live lease and report `not_found`.
   */
  const moveToProvisioning = async (grantHash: string) => {
    const row = await PendingAuthRegistration().beginProvisioning(grantHash);
    if (row?.provisioningLeaseToken) await PendingAuthRegistration().releaseProvisioningLease(row._id, row.provisioningLeaseToken);
    return row;
  };

  /**
   * Test-only fixture helper: persists a STATUS_REGISTERED `User` at a
   * pre-chosen `userId` — the exact "id reserved in the journal, User
   * created, but not yet activated" shape the AC-3 reauthentication tests
   * below seed manually (as opposed to `Fixture.generate`, which cannot
   * pin a caller-chosen `_id`).
   */
  const createRegisteredUser = async (userId: Types.ObjectId, username: string, email: string) => {
    const user = new (User())();
    user._id = userId;
    user.name = username;
    user.username = username;
    user.email = email;
    user.lang = 'en';
    user.status = User().STATUS_REGISTERED;
    user.emailConfirmedAt = new Date();
    await user.save();
    return user;
  };

  describe('registration-mode gating at the terminal (AC-1)', () => {
    it('Closed mode redirects with registration_closed and mints no grant', async () => {
      const original = (await Config().loadAllConfig()) as { crowi: Record<string, unknown> };
      const prev = original.crowi['security:registrationMode'];
      await Config().updateConfig('crowi', 'security:registrationMode', Config().SECURITY_REGISTRATION_MODE_CLOSED);
      await crowi.getConfigService().load();

      try {
        const result = await resolveProfile('fedreg-gate-closed', 'sub-gate-closed', 'fedreg-gate-closed@example.com');
        expect(result).toEqual({ kind: 'redirect_error', code: 'registration_closed' });
        expect(await PendingAuthRegistration().countDocuments({ provider: 'fedreg-gate-closed' })).toBe(0);
      } finally {
        if (prev !== undefined) {
          await Config().updateConfig('crowi', 'security:registrationMode', prev);
        } else {
          await Config().deleteOne({ ns: 'crowi', key: 'security:registrationMode' });
        }
        await crowi.getConfigService().load();
      }
    });

    it('a non-whitelisted email is redirected with email_not_allowed and mints no grant, even though the mode is not Closed', async () => {
      const original = (await Config().loadAllConfig()) as { crowi: Record<string, unknown> };
      const prev = original.crowi['security:registrationWhiteList'];
      await Config().updateConfig('crowi', 'security:registrationWhiteList', ['allowed.example.com']);
      await crowi.getConfigService().load();

      try {
        const blocked = await resolveProfile('fedreg-gate-whitelist', 'sub-gate-whitelist-blocked', 'blocked@other.test');
        expect(blocked).toEqual({ kind: 'redirect_error', code: 'email_not_allowed' });
        expect(await PendingAuthRegistration().countDocuments({ provider: 'fedreg-gate-whitelist', providerUserId: 'sub-gate-whitelist-blocked' })).toBe(0);

        // A matching address still mints a grant normally.
        const allowed = await resolveProfile('fedreg-gate-whitelist', 'sub-gate-whitelist-allowed', 'ok@allowed.example.com');
        expect(allowed.kind).toBe('registration');
      } finally {
        if (prev !== undefined) {
          await Config().updateConfig('crowi', 'security:registrationWhiteList', prev);
        } else {
          await Config().deleteOne({ ns: 'crowi', key: 'security:registrationWhiteList' });
        }
        await crowi.getConfigService().load();
      }
    });

    it("AC-1: a profile with NO email is declined (registration_unavailable) and mints no grant — the terminal's own defensive backstop, never reached in practice because the driver already requires a verified email", async () => {
      // The `email_verified === true` requirement itself lives in the driver
      // (phase 0/4) and phase 1's OIDC claim mapping — both out of this
      // phase's scope — so a profile only ever reaches this terminal already
      // verified. This pins the backstop that stands behind that contract:
      // if an email ever DID go missing, the terminal declines rather than
      // minting a grant for a row whose `profile.email` is required.
      const result = await createAuthRegistrationTerminal(crowi).resolve({
        provider: 'fedreg-gate-no-email',
        profile: { providerUserId: 'sub-gate-no-email' },
        providerLabel: 'Google',
        handoffJkt: TEST_HANDOFF_JKT,
      });

      expect(result).toEqual({ kind: 'redirect_error', code: 'registration_unavailable' });
      expect(await PendingAuthRegistration().countDocuments({ provider: 'fedreg-gate-no-email' })).toBe(0);
    });
  });

  describe('resume from a partially-completed submit (AC-5)', () => {
    it('resumes after the User already exists (crash before identity link): exactly one User, one UserIdentity', async () => {
      const provider = 'fedreg-svc-1';
      const providerUserId = 'sub-1';
      const email = 'svc-resume-user-created@example.com';
      const username = `svc-resume-1-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);
      await moveToProvisioning(grantHash);

      // Simulate: a prior attempt created the User and CASed its id into
      // the journal, then crashed before ever inserting UserIdentity.
      const [preCreated] = (await Fixture.generate('User', [{ name: 'Pre Created', username, email }])) as UserDocument[];
      await PendingAuthRegistration().updateOne({ provider, providerUserId }, { $set: { userId: preCreated._id } });

      const outcome = await provisionPendingRegistration(crowi, token, username);
      expect(outcome.kind).toBe('active');

      expect(await User().countDocuments({ email })).toBe(1);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(1);
      const identity = await UserIdentity().findOne({ provider, providerUserId });
      expect(String(identity?.userId)).toBe(String(preCreated._id));
    });

    it('resumes after the identity + activation marker already exist (crash before ACTIVE CAS): activates exactly once', async () => {
      const provider = 'fedreg-svc-2';
      const providerUserId = 'sub-2';
      const email = 'svc-resume-identity-created@example.com';
      const username = `svc-resume-2-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);
      await moveToProvisioning(grantHash);

      const [preCreated] = (await Fixture.generate('User', [{ name: 'Pre Created', username, email }])) as UserDocument[];
      await PendingAuthRegistration().updateOne({ provider, providerUserId }, { $set: { userId: preCreated._id } });
      await UserIdentity().create({ userId: preCreated._id, provider, providerUserId });
      await UserActivation().ensurePendingMarker(preCreated._id);

      const outcome = await provisionPendingRegistration(crowi, token, username);
      expect(outcome.kind).toBe('active');

      expect(await User().countDocuments({ email })).toBe(1);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(1);
      const reloaded = await User().findById(preCreated._id);
      expect(reloaded?.status).toBe(User().STATUS_ACTIVE);
    });

    it('resumes after the identity exists but the activation marker does not yet (crash between identity insert and marker creation): creates exactly one marker', async () => {
      const provider = 'fedreg-svc-2b';
      const providerUserId = 'sub-2b';
      const email = 'svc-resume-marker-not-created@example.com';
      const username = `svc-resume-2b-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);
      await moveToProvisioning(grantHash);

      const [preCreated] = (await Fixture.generate('User', [{ name: 'Pre Created', username, email }])) as UserDocument[];
      await PendingAuthRegistration().updateOne({ provider, providerUserId }, { $set: { userId: preCreated._id } });
      await UserIdentity().create({ userId: preCreated._id, provider, providerUserId });
      expect(await UserActivation().findOne({ userId: preCreated._id })).toBeNull();

      const outcome = await provisionPendingRegistration(crowi, token, username);
      expect(outcome.kind).toBe('active');

      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(1);
      expect(await UserActivation().countDocuments({ userId: preCreated._id })).toBe(1);
      const reloaded = await User().findById(preCreated._id);
      expect(reloaded?.status).toBe(User().STATUS_ACTIVE);
    });

    it('a resend after the registration FULLY completed (marker done) is rejected (not_found) — never creates a second User, never reissues a fresh token pair', async () => {
      const provider = 'fedreg-svc-3';
      const providerUserId = 'sub-3';
      const email = 'svc-resume-already-active@example.com';
      const username = `svc-resume-3-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const first = await provisionPendingRegistration(crowi, token, username);
      expect(first.kind).toBe('active');
      // By the time the (uncrashed) first call returns, its own
      // `drainUserActivation` call already marked the marker `done` — the
      // registration genuinely finished.
      if (first.kind === 'active') {
        const marker = await UserActivation().findOne({ userId: first.user._id });
        expect(marker?.status).toBe('done');
      }

      // NOT resumable once genuinely complete: the grant must not become a
      // standing bearer credential a leaked URL could replay for a fresh
      // token pair within its remaining 24h TTL. (While still incomplete —
      // ACTIVE journal but a not-yet-`done` marker — the SAME resend DOES
      // resume; see the two crash-window tests below, and AC-5/AC-6.)
      const second = await provisionPendingRegistration(crowi, token, username);
      expect(second.kind).toBe('not_found');

      expect(await User().countDocuments({ email })).toBe(1);
    });

    it('a resend during the journal-ACTIVE-but-User-not-yet-CASed crash window (crash strictly between the journal write and the User CAS) completes both and drains exactly once', async () => {
      const provider = 'fedreg-svc-8b';
      const providerUserId = 'sub-8b';
      const email = 'svc-resume-journal-active-user-registered@example.com';
      const username = `svc-resume-8b-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);
      await moveToProvisioning(grantHash);

      // Simulate: a prior attempt's guarded finalize write already flipped
      // the journal to ACTIVE, inserted the identity, and created the
      // marker — but crashed BEFORE the User's own ACTIVE CAS ever ran, so
      // the User is still REGISTERED. This is the exact gap between the
      // two writes `provisionPendingRegistration` performs.
      const [preCreated] = (await Fixture.generate('User', [{ name: 'Pre Created', username, email, status: User().STATUS_REGISTERED }])) as UserDocument[];
      expect(preCreated.status).toBe(User().STATUS_REGISTERED);
      await PendingAuthRegistration().updateOne(
        { provider, providerUserId },
        { $set: { userId: preCreated._id, state: 'ACTIVE', expiresAt: new Date(Date.now() + 1000) } },
      );
      await UserIdentity().create({ userId: preCreated._id, provider, providerUserId });
      await UserActivation().ensurePendingMarker(preCreated._id);

      const outcome = await provisionPendingRegistration(crowi, token, username);
      expect(outcome.kind).toBe('active');
      if (outcome.kind === 'active') expect(String(outcome.user._id)).toBe(String(preCreated._id));

      const reloaded = await User().findById(preCreated._id);
      expect(reloaded?.status).toBe(User().STATUS_ACTIVE);
      expect(await User().countDocuments({ email })).toBe(1);
      const marker = await UserActivation().findOne({ userId: preCreated._id });
      expect(marker?.status).toBe('done');
      const page = await Page().findPage(Page().getUserPagePath(preCreated), preCreated, {}, true);
      expect(page).not.toBeNull();
    });

    it('a resend during the ACTIVE-and-User-CASed-but-not-yet-drained crash window (page side effect not yet run) resumes and completes the drain — never creates a second User', async () => {
      const provider = 'fedreg-svc-8';
      const providerUserId = 'sub-8';
      const email = 'svc-resume-active-not-drained@example.com';
      const username = `svc-resume-8-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);
      await moveToProvisioning(grantHash);

      const [preCreated] = (await Fixture.generate('User', [{ name: 'Pre Created', username, email, status: User().STATUS_ACTIVE }])) as UserDocument[];
      await PendingAuthRegistration().updateOne(
        { provider, providerUserId },
        { $set: { userId: preCreated._id, state: 'ACTIVE', expiresAt: new Date(Date.now() + 1000) } },
      );
      await UserIdentity().create({ userId: preCreated._id, provider, providerUserId });
      await UserActivation().ensurePendingMarker(preCreated._id);
      expect(await Page().findPage(Page().getUserPagePath(preCreated), preCreated, {}, true)).toBeNull();

      const outcome = await provisionPendingRegistration(crowi, token, username);
      expect(outcome.kind).toBe('active');
      if (outcome.kind === 'active') expect(String(outcome.user._id)).toBe(String(preCreated._id));

      expect(await User().countDocuments({ email })).toBe(1);
      const page = await Page().findPage(Page().getUserPagePath(preCreated), preCreated, {}, true);
      expect(page).not.toBeNull();
      const marker = await UserActivation().findOne({ userId: preCreated._id });
      expect(marker?.status).toBe('done');
    });

    it('resumes after the id was reserved in the journal but User.save() never ran (crash between reservation and save): creates exactly one User', async () => {
      const provider = 'fedreg-svc-7';
      const providerUserId = 'sub-7';
      const email = 'svc-resume-reserved-not-created@example.com';
      const username = `svc-resume-7-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);
      await moveToProvisioning(grantHash);

      // Simulate: a prior attempt reserved a userId slot in the journal
      // (the `{userId: null}` CAS `provisionPendingRegistration` performs
      // before ever touching `User`) and then crashed before `new
      // User().save()` ran — no User document exists for this id at all.
      const reservedId = new Types.ObjectId();
      await PendingAuthRegistration().updateOne({ provider, providerUserId }, { $set: { userId: reservedId } });
      expect(await User().findById(reservedId)).toBeNull();

      const outcome = await provisionPendingRegistration(crowi, token, username);
      expect(outcome.kind).toBe('active');
      if (outcome.kind === 'active') {
        expect(String(outcome.user._id)).toBe(String(reservedId));
      }

      expect(await User().countDocuments({ email })).toBe(1);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(1);
    });

    it('AC-5: an ACTUAL fault injected at User.save() (not a manually-seeded end-state) leaves no User; the retry then creates exactly one', async () => {
      const provider = 'fedreg-svc-fault-usersave';
      const providerUserId = 'sub-fault-usersave';
      const email = 'svc-fault-usersave@example.com';
      const username = `svc-fault-usersave-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const saveSpy = jest.spyOn(User().prototype, 'save').mockImplementationOnce(async () => {
        throw new Error('injected crash: User.save()');
      });
      try {
        await expect(provisionPendingRegistration(crowi, token, username)).rejects.toThrow('injected crash: User.save()');
      } finally {
        saveSpy.mockRestore();
      }

      // The id-reservation CAS ran (durable, on the journal), but no User
      // document exists yet — the injected throw fired before persistence.
      expect(await User().countDocuments({ email })).toBe(0);

      const outcome = await provisionPendingRegistration(crowi, token, username);
      expect(outcome.kind).toBe('active');
      expect(await User().countDocuments({ email })).toBe(1);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(1);
    });

    it('AC-5: an ACTUAL fault injected at UserIdentity.create() leaves the User created but no identity; the retry then links exactly one', async () => {
      const provider = 'fedreg-svc-fault-identity';
      const providerUserId = 'sub-fault-identity';
      const email = 'svc-fault-identity@example.com';
      const username = `svc-fault-identity-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const createSpy = jest.spyOn(UserIdentity(), 'create').mockImplementationOnce(async () => {
        throw new Error('injected crash: UserIdentity.create()');
      });
      try {
        await expect(provisionPendingRegistration(crowi, token, username)).rejects.toThrow('injected crash: UserIdentity.create()');
      } finally {
        createSpy.mockRestore();
      }

      expect(await User().countDocuments({ email })).toBe(1);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(0);

      const outcome = await provisionPendingRegistration(crowi, token, username);
      expect(outcome.kind).toBe('active');
      expect(await User().countDocuments({ email })).toBe(1);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(1);
    });

    it('AC-5: an ACTUAL fault injected at UserActivation.ensurePendingMarker() leaves the identity linked but no marker; the retry then creates exactly one and activates', async () => {
      const provider = 'fedreg-svc-fault-marker';
      const providerUserId = 'sub-fault-marker';
      const email = 'svc-fault-marker@example.com';
      const username = `svc-fault-marker-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const markerSpy = jest.spyOn(UserActivation(), 'ensurePendingMarker').mockImplementationOnce(async () => {
        throw new Error('injected crash: UserActivation.ensurePendingMarker()');
      });
      try {
        await expect(provisionPendingRegistration(crowi, token, username)).rejects.toThrow('injected crash: UserActivation.ensurePendingMarker()');
      } finally {
        markerSpy.mockRestore();
      }

      expect(await User().countDocuments({ email })).toBe(1);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(1);
      const createdBefore = await User().findOne({ email });
      expect(createdBefore?.status).toBe(User().STATUS_REGISTERED);
      expect(await UserActivation().findOne({ userId: createdBefore?._id })).toBeNull();

      const outcome = await provisionPendingRegistration(crowi, token, username);
      expect(outcome.kind).toBe('active');
      if (outcome.kind === 'active') expect(outcome.user.status).toBe(User().STATUS_ACTIVE);
      expect(await User().countDocuments({ email })).toBe(1);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(1);
      expect(await UserActivation().countDocuments({ userId: createdBefore?._id })).toBe(1);
    });

    it('AC-5: an ACTUAL fault injected at the User ACTIVE CAS leaves the journal already ACTIVE but the User still REGISTERED; the retry then completes the CAS exactly once', async () => {
      const provider = 'fedreg-svc-fault-activecas';
      const providerUserId = 'sub-fault-activecas';
      const email = 'svc-fault-activecas@example.com';
      const username = `svc-fault-activecas-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const updateOneSpy = jest.spyOn(User(), 'updateOne').mockImplementationOnce(async () => {
        throw new Error('injected crash: User ACTIVE CAS');
      });
      try {
        await expect(provisionPendingRegistration(crowi, token, username)).rejects.toThrow('injected crash: User ACTIVE CAS');
      } finally {
        updateOneSpy.mockRestore();
      }

      // The journal's own ACTIVE write landed (it runs strictly BEFORE the
      // User CAS this spy intercepts), but the User itself never flipped.
      const row = await PendingAuthRegistration().findOne({ provider, providerUserId });
      expect(row?.state).toBe('ACTIVE');
      const createdBefore = await User().findOne({ email });
      expect(createdBefore?.status).toBe(User().STATUS_REGISTERED);

      const outcome = await provisionPendingRegistration(crowi, token, username);
      expect(outcome.kind).toBe('active');
      if (outcome.kind === 'active') expect(outcome.user.status).toBe(User().STATUS_ACTIVE);
      expect(await User().countDocuments({ email })).toBe(1);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(1);
    });

    it('rejects a syntactically invalid username (defense in depth — same UsernameSchema the contract layer already enforces)', async () => {
      const provider = 'fedreg-svc-4';
      const providerUserId = 'sub-4';
      const email = 'svc-invalid-username@example.com';
      await User().deleteMany({ email });

      const token = await seedGrant(provider, providerUserId, email);
      const outcome = await provisionPendingRegistration(crowi, token, 'bad.name');
      expect(outcome.kind).toBe('invalid_username');
      expect(await User().countDocuments({ email })).toBe(0);
    });
  });

  describe('durable activation marker + idempotent page side effect (AC-6)', () => {
    it('drains a pending marker exactly once — a second drain on a done marker is a no-op', async () => {
      const username = randomUsername();
      const [user] = (await Fixture.generate('User', [{ name: faker.name.findName(), username, email: faker.internet.email() }])) as UserDocument[];
      user.status = User().STATUS_ACTIVE;
      await user.save();
      await UserActivation().ensurePendingMarker(user._id);

      await drainUserActivation(crowi, user._id);
      const page = await Page().findPage(Page().getUserPagePath(user), user, {}, true);
      expect(page).not.toBeNull();

      const marker = await UserActivation().findOne({ userId: user._id });
      expect(marker?.status).toBe('done');

      // Second drain: marker is done, claim returns null, no page duplicate/rename.
      await drainUserActivation(crowi, user._id);
      const stillSamePage = await Page().findPage(Page().getUserPagePath(user), user, {}, true);
      expect(String(stillSamePage?._id)).toBe(String(page?._id));
    });

    it('never renames a pre-existing manually-created user page', async () => {
      const username = randomUsername();
      const [user] = (await Fixture.generate('User', [{ name: faker.name.findName(), username, email: faker.internet.email() }])) as UserDocument[];
      user.status = User().STATUS_ACTIVE;
      await user.save();

      const manualPath = Page().getUserPagePath(user);
      const manualPage = await Page().createPage(manualPath, '# manually created', user, {});

      await UserActivation().ensurePendingMarker(user._id);
      await drainUserActivation(crowi, user._id);

      const reloadedPage = await Page().findPage(manualPath, user, {}, true);
      expect(String(reloadedPage?._id)).toBe(String(manualPage._id));

      // No rename side effect: nothing landed under /tmp/user-<username>-*.
      const renamed = await Page().findOne({ path: new RegExp(`^/tmp/user-${username}-`) });
      expect(renamed).toBeNull();
    });

    it('an expired lease is reclaimed; a live lease is not', async () => {
      const username = randomUsername();
      const [user] = (await Fixture.generate('User', [{ name: faker.name.findName(), username, email: faker.internet.email() }])) as UserDocument[];

      await UserActivation().ensurePendingMarker(user._id);
      const firstClaim = await UserActivation().claimActivationLease(user._id);
      expect(firstClaim).not.toBeNull();
      expect(firstClaim?.status).toBe('running');

      // A live lease cannot be claimed again.
      const blocked = await UserActivation().claimActivationLease(user._id);
      expect(blocked).toBeNull();

      // Simulate the lease lapsing (the original claimant crashed).
      await UserActivation().updateOne({ userId: user._id }, { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } });
      const reclaimed = await UserActivation().claimActivationLease(user._id);
      expect(reclaimed).not.toBeNull();
    });

    it('an ACTUAL fault injected exactly at the page side effect leaves a claimed-but-not-done marker; the lease-expiry retry then completes it exactly once', async () => {
      const username = randomUsername();
      const [user] = (await Fixture.generate('User', [{ name: faker.name.findName(), username, email: faker.internet.email() }])) as UserDocument[];
      user.status = User().STATUS_ACTIVE;
      await user.save();
      await UserActivation().ensurePendingMarker(user._id);

      // A genuine thrown exception during `ensureUserPage` (not a manually
      // seeded end-state, unlike the other AC-5/AC-6 tests) — models a
      // real crash (e.g. a DB write failure) mid-side-effect.
      const createPageSpy = jest.spyOn(Page(), 'createPage').mockImplementationOnce(async () => {
        throw new Error('injected crash: page side effect');
      });
      try {
        await expect(drainUserActivation(crowi, user._id)).rejects.toThrow('injected crash: page side effect');
      } finally {
        createPageSpy.mockRestore();
      }

      // The lease was claimed (status flipped to `running`) before the
      // injected throw — `markActivationDone` never ran, and no page was
      // created.
      const stuck = await UserActivation().findOne({ userId: user._id });
      expect(stuck?.status).toBe('running');
      expect(await Page().findPage(Page().getUserPagePath(user), user, {}, true)).toBeNull();

      // Simulate the lease lapsing and retry (the recovery path AC-6
      // requires) — completes exactly once, no duplicate/rename.
      await UserActivation().updateOne({ userId: user._id }, { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } });
      await drainUserActivation(crowi, user._id);

      const page = await Page().findPage(Page().getUserPagePath(user), user, {}, true);
      expect(page).not.toBeNull();
      const marker = await UserActivation().findOne({ userId: user._id });
      expect(marker?.status).toBe('done');
    });

    it('AC-5/AC-6: a live activation lease held by ANOTHER caller (the page side effect not yet confirmed complete) is never silently reported as a finished activation — the submit fails loudly (retryable), never issuing a handoff for an unconfirmed activation', async () => {
      const provider = 'fedreg-svc-drain-holding';
      const providerUserId = 'sub-drain-holding';
      const email = 'svc-drain-holding@example.com';
      const username = `svc-drain-holding-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);
      await moveToProvisioning(grantHash);

      const [preCreated] = (await Fixture.generate('User', [{ name: 'Pre Created', username, email, status: User().STATUS_REGISTERED }])) as UserDocument[];
      await PendingAuthRegistration().updateOne(
        { provider, providerUserId },
        { $set: { userId: preCreated._id, state: 'ACTIVE', expiresAt: new Date(Date.now() + 10 * 60 * 1000) } },
      );
      await UserIdentity().create({ userId: preCreated._id, provider, providerUserId });
      await UserActivation().ensurePendingMarker(preCreated._id);
      // Model: a PRIOR resend already claimed the activation lease and is
      // (as far as this call can tell) still genuinely running it — this
      // call must not report success on its behalf, previously the exact
      // gap `drainUserActivation`'s old `void`-returning shape hid.
      const held = await UserActivation().claimActivationLease(preCreated._id);
      expect(held?.status).toBe('running');

      await expect(provisionPendingRegistration(crowi, token, username)).rejects.toThrow(/could not be confirmed complete/);

      // Nothing durable was rolled back by the rejected attempt: the
      // account genuinely is ACTIVE and the journal genuinely is ACTIVE —
      // only the page side effect stayed unconfirmed.
      const reloaded = await User().findById(preCreated._id);
      expect(reloaded?.status).toBe(User().STATUS_ACTIVE);
      expect(await User().countDocuments({ email })).toBe(1);
      const row = await PendingAuthRegistration().findOne({ provider, providerUserId });
      expect(row?.state).toBe('ACTIVE');

      // Once the OTHER caller's lease genuinely lapses, a plain resubmit of
      // the SAME grant converges normally (never a second User) — proving
      // the failure above was retryable, not a dead end.
      await UserActivation().updateOne({ userId: preCreated._id }, { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } });
      const outcome = await provisionPendingRegistration(crowi, token, username);
      expect(outcome.kind).toBe('active');
      if (outcome.kind === 'active') expect(String(outcome.user._id)).toBe(String(preCreated._id));
      expect(await User().countDocuments({ email })).toBe(1);
      const marker = await UserActivation().findOne({ userId: preCreated._id });
      expect(marker?.status).toBe('done');
    });

    it('re-authenticating via the terminal ALSO retries a stalled drain for an already-ACTIVE identity (design decision 4 — the "callback 再開" recovery path)', async () => {
      const provider = 'fedreg-svc-reauth-drain';
      const providerUserId = 'sub-reauth-drain';
      const username = randomUsername();
      const [user] = (await Fixture.generate('User', [{ name: faker.name.findName(), username, email: faker.internet.email() }])) as UserDocument[];
      user.status = User().STATUS_ACTIVE;
      await user.save();
      await UserIdentity().create({ userId: user._id, provider, providerUserId });
      // A marker that was created but never drained — the exact durable
      // record a crash between the ACTIVE CAS and `ensureUserPage` leaves
      // behind. Once the identity exists, `provisionPendingRegistration`
      // can no longer be reached (the terminal resolves it directly) — the
      // terminal's own "resolved" branch is the only remaining recovery
      // path for this crash window.
      await UserActivation().ensurePendingMarker(user._id);
      expect(await Page().findPage(Page().getUserPagePath(user), user, {}, true)).toBeNull();

      const result = await resolveProfile(provider, providerUserId, user.email);
      expect(result.kind).toBe('resolved');

      const page = await Page().findPage(Page().getUserPagePath(user), user, {}, true);
      expect(page).not.toBeNull();
      const marker = await UserActivation().findOne({ userId: user._id });
      expect(marker?.status).toBe('done');
    });

    it("AC-6: re-authenticating for an already-ACTIVE identity whose activation marker is held by ANOTHER caller (a live lease — a genuinely concurrent drain, or a prior crash whose lease has not lapsed) never resolves as success — it fails loudly (retryable), same contract as provisionClaimedRow's own handling of this exact shape", async () => {
      const provider = 'fedreg-svc-reauth-drain-holding';
      const providerUserId = 'sub-reauth-drain-holding';
      const username = randomUsername();
      const [user] = (await Fixture.generate('User', [{ name: faker.name.findName(), username, email: faker.internet.email() }])) as UserDocument[];
      user.status = User().STATUS_ACTIVE;
      await user.save();
      await UserIdentity().create({ userId: user._id, provider, providerUserId });
      await UserActivation().ensurePendingMarker(user._id);
      // Model: a PRIOR resend (or a genuinely concurrent one) already
      // claimed the activation lease and is, as far as THIS call can tell,
      // still running it — a regression to the old `void`-returning
      // `drainUserActivation` shape would have this branch ignore that and
      // resolve anyway, silently stranding the marker.
      const held = await UserActivation().claimActivationLease(user._id);
      expect(held?.status).toBe('running');

      await expect(resolveProfile(provider, providerUserId, user.email)).rejects.toThrow(/could not be confirmed complete/);

      // Nothing durable was rolled back: the account genuinely is ACTIVE,
      // only the page side effect stayed unconfirmed.
      expect((await User().findById(user._id))?.status).toBe(User().STATUS_ACTIVE);
      expect(await Page().findPage(Page().getUserPagePath(user), user, {}, true)).toBeNull();

      // Once the OTHER caller's lease genuinely lapses, re-authenticating
      // again converges normally — proving the failure above was
      // retryable, not a dead end.
      await UserActivation().updateOne({ userId: user._id }, { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } });
      const retried = await resolveProfile(provider, providerUserId, user.email);
      expect(retried.kind).toBe('resolved');
      expect(await Page().findPage(Page().getUserPagePath(user), user, {}, true)).not.toBeNull();
      expect((await UserActivation().findOne({ userId: user._id }))?.status).toBe('done');
    });

    it('AC-3: re-authenticating after the identity was linked but BEFORE the User reached ACTIVE reissues a grant on the SAME journal row instead of resolving a dead-end REGISTERED user', async () => {
      const provider = 'fedreg-svc-reauth-not-active';
      const providerUserId = 'sub-reauth-not-active';
      const email = 'fedreg-reauth-not-active@example.com';
      const username = randomUsername();
      await User().deleteMany({ email });

      // Model the EXACT crash window: `ensureIdentityLink` succeeded but
      // the journal never reached its own ACTIVE write (or reached it but
      // the User CAS immediately after never ran) — the User is a real,
      // persisted document, still STATUS_REGISTERED. A prior version of
      // `createAuthRegistrationTerminal` returned `{kind:'resolved', user}`
      // here regardless of status, which `completeFederatedCallback` maps
      // to a dead-end `account_inactive` redirect — no grant, no way to
      // finish, and the ORIGINAL grant token is gone (the browser already
      // navigated away from it once).
      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);
      const row = await moveToProvisioning(grantHash);
      if (!row) throw new Error('expected beginProvisioning to succeed');
      const userId = new Types.ObjectId();
      await PendingAuthRegistration().updateOne({ _id: row._id }, { $set: { userId } });
      await createRegisteredUser(userId, username, email);
      await UserIdentity().create({ userId, provider, providerUserId });

      const result = await resolveProfile(provider, providerUserId, email);
      expect(result.kind).toBe('registration');
      const newToken = (result as { kind: 'registration'; token: string }).token;
      expect(newToken).not.toBe(token);

      // The reissued grant resumes the SAME journal row (same userId) —
      // completing it must activate the SAME User, never create a second one.
      const submitResult = await provisionPendingRegistration(crowi, newToken, username);
      expect(submitResult.kind).toBe('active');
      if (submitResult.kind === 'active') {
        expect(String(submitResult.user._id)).toBe(String(userId));
        expect(submitResult.user.status).toBe(User().STATUS_ACTIVE);
      }
      expect(await User().countDocuments({ email })).toBe(1);
    });

    it('AC-3/AC-5: re-authenticating after a crash BETWEEN User creation and the UserIdentity insert reissues a grant on the SAME journal row, instead of rejecting the resume as email_already_registered', async () => {
      const provider = 'fedreg-svc-reauth-no-identity-yet';
      const providerUserId = 'sub-reauth-no-identity-yet';
      const email = 'fedreg-reauth-no-identity-yet@example.com';
      const username = randomUsername();
      await User().deleteMany({ email });

      // Model the crash window ONE STEP EARLIER than the test above: the
      // journal reserved a `userId` and the User was created (and CASed
      // into the journal row), but the process crashed BEFORE
      // `ensureIdentityLink` ever ran — no `UserIdentity` row exists yet.
      // The terminal's identity lookup (`UserIdentity.findOne`) therefore
      // MISSES entirely, landing in the "unknown identity" branch — which,
      // before this fix, ran the FRESH-registration gates (including the
      // "no auto-link" email-collision check) and found this VERY User by
      // its own email, wrongly rejecting the resume as
      // `email_already_registered` with no way to ever finish.
      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);
      const row = await moveToProvisioning(grantHash);
      if (!row) throw new Error('expected beginProvisioning to succeed');
      const userId = new Types.ObjectId();
      await PendingAuthRegistration().updateOne({ _id: row._id }, { $set: { userId } });
      await createRegisteredUser(userId, username, email);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(0);

      const result = await resolveProfile(provider, providerUserId, email);
      expect(result.kind).toBe('registration');
      const newToken = (result as { kind: 'registration'; token: string }).token;
      expect(newToken).not.toBe(token);

      // The reissued grant resumes the SAME journal row (same userId) —
      // completing it must activate the SAME User (by id), never create a
      // second one just because its email collided with its own earlier
      // attempt.
      const submitResult = await provisionPendingRegistration(crowi, newToken, username);
      expect(submitResult.kind).toBe('active');
      if (submitResult.kind === 'active') {
        expect(String(submitResult.user._id)).toBe(String(userId));
        expect(submitResult.user.status).toBe(User().STATUS_ACTIVE);
      }
      expect(await User().countDocuments({ email })).toBe(1);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(1);
    });

    it('a resolved identity whose marker is already done does not re-run the drain (no-op, still resolved)', async () => {
      const provider = 'fedreg-svc-reauth-done';
      const providerUserId = 'sub-reauth-done';
      const username = randomUsername();
      const [user] = (await Fixture.generate('User', [{ name: faker.name.findName(), username, email: faker.internet.email() }])) as UserDocument[];
      user.status = User().STATUS_ACTIVE;
      await user.save();
      await UserIdentity().create({ userId: user._id, provider, providerUserId });
      await UserActivation().ensurePendingMarker(user._id);
      await drainUserActivation(crowi, user._id);
      const page = await Page().findPage(Page().getUserPagePath(user), user, {}, true);

      const result = await resolveProfile(provider, providerUserId, user.email);
      expect(result.kind).toBe('resolved');

      const stillSamePage = await Page().findPage(Page().getUserPagePath(user), user, {}, true);
      expect(String(stillSamePage?._id)).toBe(String(page?._id));
    });

    it('AC-3/AC-5: re-authenticating after a CANCELLED row that had already reserved a userId revives the SAME journal row instead of orphaning the already-created User (regression: issueRegistrationGrant used to reset userId to null on ANY CANCELLED row, not only one that never reserved one — e.g. register (Restricted) -> APPROVAL_PENDING -> logout -> re-auth)', async () => {
      const provider = 'fedreg-svc-revive-cancelled';
      const providerUserId = 'sub-revive-cancelled';
      const email = 'fedreg-revive-cancelled@example.com';
      const username = `svc-revive-cancelled-${Date.now()}`;
      await User().deleteMany({ email });

      // Model: a submit already reserved a `userId`, created the (still
      // REGISTERED — e.g. Restricted mode awaiting approval, or a crash
      // before the ACTIVE CAS) User, and linked the identity — and THEN the
      // registration screen's logout link cancelled the row
      // (`hono/handlers/federated-registration.ts#logoutPendingRegistration`,
      // modelled here directly on the journal since this is a model/service
      // -layer test).
      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);
      const row = await moveToProvisioning(grantHash);
      if (!row) throw new Error('expected beginProvisioning to succeed');
      const userId = new Types.ObjectId();
      await PendingAuthRegistration().updateOne({ _id: row._id }, { $set: { userId } });
      await createRegisteredUser(userId, username, email);
      await UserIdentity().create({ userId, provider, providerUserId });
      await PendingAuthRegistration().updateOne({ _id: row._id }, { $set: { state: 'CANCELLED', expiresAt: new Date(Date.now() + 10 * 60 * 1000) } });

      const result = await resolveProfile(provider, providerUserId, email);
      expect(result.kind).toBe('registration');
      const newToken = (result as { kind: 'registration'; token: string }).token;
      expect(newToken).not.toBe(token);

      // The revived row must keep the SAME userId — never reset to null,
      // which would orphan the already-created User: the next submit would
      // reserve a BRAND NEW userId, and its content-based conflict check
      // would then find the ORIGINAL account by email and report a
      // spurious, permanent conflict against the user's own prior account.
      const revivedRow = await PendingAuthRegistration().findOne({ provider, providerUserId });
      expect(revivedRow?.state).toBe('PROVISIONING');
      expect(String(revivedRow?.userId)).toBe(String(userId));

      const submitResult = await provisionPendingRegistration(crowi, newToken, username);
      expect(submitResult.kind).toBe('active');
      if (submitResult.kind === 'active') {
        expect(String(submitResult.user._id)).toBe(String(userId));
      }
      expect(await User().countDocuments({ email })).toBe(1);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(1);
    });

    it('AC-3: re-authenticating after a CANCELLED row that had reserved a userId AND created the User, but crashed BEFORE the UserIdentity insert, revives the SAME row instead of dead-ending on email_already_registered (regression: the fresh/resume gate at the terminal used to route EVERY CANCELLED row — regardless of whether it had already reserved a userId — through the fresh-registration gates, which found this VERY User by email and rejected the resume permanently)', async () => {
      const provider = 'fedreg-svc-revive-cancelled-no-identity';
      const providerUserId = 'sub-revive-cancelled-no-identity';
      const email = 'fedreg-revive-cancelled-no-identity@example.com';
      const username = `svc-revive-cancelled-no-identity-${Date.now()}`;
      await User().deleteMany({ email });

      // Model the crash window ONE STEP EARLIER than the revive-cancelled
      // test above: the journal reserved a `userId` and the User was
      // created (and CASed into the journal row), but the process crashed
      // BEFORE `ensureIdentityLink` ever ran — no `UserIdentity` exists —
      // and THEN the registration screen's logout link cancelled the
      // still-PROVISIONING row. The terminal's identity lookup
      // (`UserIdentity.findOne`) therefore MISSES entirely, landing in the
      // "unknown identity" branch, whose `existingRow` gate must recognize
      // this row (CANCELLED, but with a reserved `userId`) as a REVIVE
      // case, not a FRESH one.
      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);
      const row = await moveToProvisioning(grantHash);
      if (!row) throw new Error('expected beginProvisioning to succeed');
      const userId = new Types.ObjectId();
      await PendingAuthRegistration().updateOne({ _id: row._id }, { $set: { userId } });
      await createRegisteredUser(userId, username, email);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(0);
      await PendingAuthRegistration().updateOne({ _id: row._id }, { $set: { state: 'CANCELLED', expiresAt: new Date(Date.now() + 10 * 60 * 1000) } });

      const result = await resolveProfile(provider, providerUserId, email);
      // Before the fix, this returned `{kind: 'redirect_error', code:
      // 'email_already_registered'}` — the terminal's own "no auto-link"
      // check found the User created by this row's own earlier (crashed)
      // attempt and permanently rejected the resume.
      expect(result.kind).toBe('registration');
      const newToken = (result as { kind: 'registration'; token: string }).token;
      expect(newToken).not.toBe(token);

      const revivedRow = await PendingAuthRegistration().findOne({ provider, providerUserId });
      expect(revivedRow?.state).toBe('PROVISIONING');
      expect(String(revivedRow?.userId)).toBe(String(userId));

      // The reissued grant resumes the SAME journal row (same userId) and
      // finally links the identity that never got created before —
      // completing it must activate the SAME User, never create a second
      // one just because its email collided with its own earlier attempt.
      const submitResult = await provisionPendingRegistration(crowi, newToken, username);
      expect(submitResult.kind).toBe('active');
      if (submitResult.kind === 'active') {
        expect(String(submitResult.user._id)).toBe(String(userId));
        expect(submitResult.user.status).toBe(User().STATUS_ACTIVE);
      }
      expect(await User().countDocuments({ email })).toBe(1);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(1);
    });
  });

  describe('the callback (issueRegistrationGrant) racing the submit path (beginProvisioning) targets the SAME journal row (coverage for the issueRegistrationGrant atomic-CAS rewrite)', () => {
    it('a re-authentication callback landing WHILE a submit already flipped the row to PROVISIONING reissues (preserves), never resets state/userId back to a fresh PENDING row — the OLD grant stops working, the NEW one resumes the SAME row', async () => {
      const provider = 'fedreg-svc-callback-vs-submit-race';
      const providerUserId = 'sub-callback-vs-submit-race';
      const email = 'fedreg-callback-vs-submit-race@example.com';
      const username = `svc-callback-vs-submit-race-${Date.now()}`;
      await User().deleteMany({ email });

      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);

      // Deterministically reproduce the interleave: the submit's OWN
      // `beginProvisioning` CAS (PENDING -> PROVISIONING) has ALREADY
      // landed when a re-authentication callback for the SAME
      // `{provider, providerUserId}` races in and calls
      // `issueRegistrationGrant` (via the terminal's `issueGrant`). The
      // OLD (read-then-write) `issueRegistrationGrant` implementation read
      // the row BEFORE this transition, decided FRESH, and then wrote
      // unconditionally — silently resetting `state`/`userId` back to a
      // fresh PENDING row and orphaning whatever the submit had already
      // reserved. The NEW implementation is a bounded loop of genuine
      // atomic CAS attempts (state condition baked into the filter itself,
      // never a value merely read beforehand), so it must instead fall
      // through its FRESH attempt (fails to match) into its REISSUE
      // (preserve) attempt (matches PROVISIONING) regardless of this
      // ordering.
      const provisioningRow = await moveToProvisioning(grantHash);
      if (!provisioningRow) throw new Error('expected beginProvisioning to succeed');
      expect(provisioningRow.state).toBe('PROVISIONING');
      expect(provisioningRow.userId).toBeNull();

      const result = await resolveProfile(provider, providerUserId, email);
      expect(result.kind).toBe('registration');
      const newToken = (result as { kind: 'registration'; token: string }).token;
      expect(newToken).not.toBe(token);

      // The row must have STAYED PROVISIONING (never reset to PENDING) —
      // this is the exact invariant the OLD read-then-write implementation
      // could violate under this ordering.
      const raced = await PendingAuthRegistration().findOne({ provider, providerUserId });
      expect(raced?.state).toBe('PROVISIONING');
      expect(raced?.userId).toBeNull();

      // The OLD grant (from before the race) no longer resolves anything —
      // its hash was rotated away by the reissue.
      expect(await PendingAuthRegistration().findByRegistrationGrant(token)).toBeNull();

      // The NEW grant resumes the SAME row end-to-end: exactly one User,
      // one UserIdentity, no corruption from the race.
      const submitResult = await provisionPendingRegistration(crowi, newToken, username);
      expect(submitResult.kind).toBe('active');
      expect(await User().countDocuments({ email })).toBe(1);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(1);
    });

    it('a genuinely concurrent re-authentication callback and submit for the SAME grant never corrupt the journal — exactly one User/UserIdentity survive regardless of which wins', async () => {
      const provider = 'fedreg-svc-callback-vs-submit-concurrent';
      const providerUserId = 'sub-callback-vs-submit-concurrent';
      const email = 'fedreg-callback-vs-submit-concurrent@example.com';
      const username = `svc-callback-vs-submit-concurrent-${Date.now()}`;
      await User().deleteMany({ email });

      const token = await seedGrant(provider, providerUserId, email);

      // Genuinely concurrent: a re-auth callback (issueRegistrationGrant,
      // via the terminal) racing the ORIGINAL grant's own submit
      // (beginProvisioning + the full state machine, via
      // provisionPendingRegistration). Whichever wins, the row must
      // converge cleanly — never two Users, never an orphaned `userId`.
      const [terminalResult, submitResult] = await Promise.all([
        resolveProfile(provider, providerUserId, email),
        provisionPendingRegistration(crowi, token, username),
      ]);

      expect(terminalResult.kind).toBe('registration');
      // The submit either won outright (`active`, if its own `beginProvisioning`
      // claimed the row before the reissue rotated the grant hash out from
      // under it) or lost the race entirely (`not_found`, if the reissue
      // won first) — both are acceptable outcomes; a spurious `conflict` is
      // not. Exactly which one happened decides how many documents this
      // single submit attempt could possibly have created: it either ran
      // its FULL create-User/link-identity/activate sequence exactly once,
      // or it never got past `beginProvisioning` at all.
      expect(['active', 'not_found']).toContain(submitResult.kind);
      const submitWon = submitResult.kind === 'active';

      expect(await User().countDocuments({ email })).toBe(submitWon ? 1 : 0);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(submitWon ? 1 : 0);
      expect(await PendingAuthRegistration().countDocuments({ provider, providerUserId })).toBe(1);
    });
  });

  describe('an expired ACTIVE row is not indefinitely resumable (regression)', () => {
    it('beginProvisioning rejects (not_found) an ACTIVE row whose 24h expiresAt has already passed, even though its activation marker never reached done', async () => {
      const provider = 'fedreg-svc-active-expired';
      const providerUserId = 'sub-active-expired';
      const email = 'svc-active-expired@example.com';
      const username = `svc-active-expired-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);
      await moveToProvisioning(grantHash);

      const [preCreated] = (await Fixture.generate('User', [{ name: 'Pre Created', username, email, status: User().STATUS_REGISTERED }])) as UserDocument[];
      // Past expiry: the ACTIVE row's own 24h TTL already lapsed, but its
      // activation marker never reached `done` — the exact shape a stuck
      // marker can leave a grant in indefinitely without this check.
      await PendingAuthRegistration().updateOne(
        { provider, providerUserId },
        { $set: { userId: preCreated._id, state: 'ACTIVE', expiresAt: new Date(Date.now() - 1000) } },
      );
      await UserIdentity().create({ userId: preCreated._id, provider, providerUserId });
      await UserActivation().ensurePendingMarker(preCreated._id);

      const outcome = await provisionPendingRegistration(crowi, token, username);
      expect(outcome.kind).toBe('not_found');

      // Nothing was mutated by the rejected attempt.
      const row = await PendingAuthRegistration().findOne({ provider, providerUserId });
      expect(row?.state).toBe('ACTIVE');
      expect(row?.expiresAt?.getTime()).toBeLessThan(Date.now());
      const reloaded = await User().findById(preCreated._id);
      expect(reloaded?.status).toBe(User().STATUS_REGISTERED);
    });

    it('a resumed (not fresh) ACTIVE completion does not extend expiresAt another 24h — only a genuinely FIRST completion sets a fresh terminal TTL', async () => {
      const provider = 'fedreg-svc-active-no-extend';
      const providerUserId = 'sub-active-no-extend';
      const email = 'svc-active-no-extend@example.com';
      const username = `svc-active-no-extend-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);
      await moveToProvisioning(grantHash);

      const [preCreated] = (await Fixture.generate('User', [{ name: 'Pre Created', username, email, status: User().STATUS_REGISTERED }])) as UserDocument[];
      // Still valid, but nowhere near what a freshly-set ~24h terminal TTL
      // would look like — if the finalize write re-extended it, this
      // wouldn't survive the round trip unchanged.
      const nearExpiry = new Date(Date.now() + 5000);
      await PendingAuthRegistration().updateOne({ provider, providerUserId }, { $set: { userId: preCreated._id, state: 'ACTIVE', expiresAt: nearExpiry } });
      await UserIdentity().create({ userId: preCreated._id, provider, providerUserId });
      await UserActivation().ensurePendingMarker(preCreated._id);

      const outcome = await provisionPendingRegistration(crowi, token, username);
      expect(outcome.kind).toBe('active');

      const row = await PendingAuthRegistration().findOne({ provider, providerUserId });
      expect(row?.expiresAt?.getTime()).toBe(nearExpiry.getTime());
    });
  });

  describe('concurrency safety (AC-7)', () => {
    it('AC-7: parallel submit of the SAME grant + username — exactly ONE wins (single-flight lease), the other is rejected, never a spurious conflict', async () => {
      const provider = 'fedreg-svc-5';
      const providerUserId = 'sub-5';
      const email = 'svc-concurrent-submit@example.com';
      const username = `svc-concurrent-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const [a, b] = await Promise.all([provisionPendingRegistration(crowi, token, username), provisionPendingRegistration(crowi, token, username)]);

      // AC-7 (single-winner): `beginProvisioning`'s single-flight lease
      // means a TRUE-concurrent second caller for the SAME grant never even
      // enters the state machine body — it observes the lease still live
      // and is rejected as `not_found`, never a spurious `conflict` (the
      // old, pre-lease behaviour this test used to guard against by
      // tolerating either outcome).
      expect([a.kind, b.kind]).not.toContain('conflict');
      const succeeded = [a, b].filter((outcome) => outcome.kind === 'active');
      const rejected = [a, b].filter((outcome) => outcome.kind === 'not_found');
      expect(succeeded).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      expect(await User().countDocuments({ email })).toBe(1);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(1);
    });

    it("AC-7: parallel submit of the SAME grant with DIFFERENT usernames — still exactly one winner, and the single created User carries the WINNER's username (never a blend, never two accounts)", async () => {
      const provider = 'fedreg-svc-5c';
      const providerUserId = 'sub-5c';
      const email = 'svc-concurrent-distinct-usernames@example.com';
      const usernameA = `svc-concurrent-a-${Date.now()}`;
      const usernameB = `svc-concurrent-b-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username: usernameA }, { username: usernameB }] });

      const token = await seedGrant(provider, providerUserId, email);
      const [a, b] = await Promise.all([provisionPendingRegistration(crowi, token, usernameA), provisionPendingRegistration(crowi, token, usernameB)]);

      // Distinct usernames are the sharper version of the same-username race
      // above: without the single-flight lease, BOTH callers could reach
      // `createUserForRegistration` against the SAME reserved userId and
      // race on the username unique index — one would win and the other
      // would report a spurious `conflict` about a username the registrant
      // themselves just picked. With the lease, the loser never enters the
      // state machine body at all.
      expect([a.kind, b.kind]).not.toContain('conflict');
      const succeeded = [a, b].filter((outcome) => outcome.kind === 'active');
      expect(succeeded).toHaveLength(1);
      expect([a, b].filter((outcome) => outcome.kind === 'not_found')).toHaveLength(1);

      // Exactly one account, and its username is whichever call actually won
      // — never a mix, and never a second account for the loser's username.
      expect(await User().countDocuments({ email })).toBe(1);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(1);
      const winner = succeeded[0] as Extract<typeof a, { kind: 'active' }>;
      const created = await User().findOne({ email });
      expect([usernameA, usernameB]).toContain(created?.username);
      expect(created?.username).toBe(winner.user.username);
      const loserUsername = created?.username === usernameA ? usernameB : usernameA;
      expect(await User().countDocuments({ username: loserUsername })).toBe(0);
    });

    it('AC-7: a SERIAL resend of a NOT-YET-fully-drained row still resumes normally once the first call releases its lease — never wrongly rejected as a "loser"', async () => {
      const provider = 'fedreg-svc-5b';
      const providerUserId = 'sub-5b';
      const email = 'svc-serial-resend@example.com';
      const username = `svc-serial-resend-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);

      // The first call completes its OWN state machine (journal ACTIVE,
      // User ACTIVE) but the activation-time page side effect throws —
      // `provisionPendingRegistration` propagates that (never swallowed),
      // so this models a genuinely CRASHED first attempt (distinct from the
      // "marker done" test above, which correctly expects `not_found` for
      // a resend AFTER full completion). The `finally` wrapping
      // `provisionClaimedRow` must still release the lease on this THROW
      // path — not only on a clean return — or a retry would be blocked for
      // the full 30s lease window.
      const pageSpy = jest.spyOn(Page(), 'createPage').mockImplementationOnce(async () => {
        throw new Error('injected crash: page side effect');
      });
      try {
        await expect(provisionPendingRegistration(crowi, token, username)).rejects.toThrow('injected crash: page side effect');
      } finally {
        pageSpy.mockRestore();
      }
      const createdBefore = await User().findOne({ email });
      expect(createdBefore?.status).toBe(User().STATUS_ACTIVE);
      const marker = await UserActivation().findOne({ userId: createdBefore?._id });
      expect(marker?.status).not.toBe('done');

      // `UserActivation`'s OWN, separate 60s lease from the crashed drain
      // attempt is still live at this point — a re-drain right now would
      // (correctly, per AC-5/AC-6) report `'holding'`, not `'done'`, and
      // this call would fail loudly rather than falsely report success.
      // That path is this suite's own dedicated coverage (the "a live
      // activation lease held by ANOTHER caller..." test above) — not what
      // THIS test verifies. Expire it explicitly (the same technique the
      // AC-6 section above uses) to isolate the ONE thing this test targets:
      // the AC-7 `PendingAuthRegistration` single-flight lease must not
      // wrongly reject a genuinely SEQUENTIAL resend as a losing racer — the
      // first call already released THAT lease in its `finally` before this
      // one starts.
      await UserActivation().updateOne({ userId: createdBefore?._id }, { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } });

      const second = await provisionPendingRegistration(crowi, token, username);
      expect(second.kind).toBe('active');
      if (second.kind === 'active') {
        expect(String(second.user._id)).toBe(String(createdBefore?._id));
      }
    });

    it("AC-7: a lease that expires while its ORIGINAL caller is still (unknowingly) running is fenced — the original caller's own stale release cannot clear a NEW caller's live reclaim, and a THIRD caller stays rejected", async () => {
      const provider = 'fedreg-svc-lease-fencing';
      const providerUserId = 'sub-lease-fencing';
      const email = 'svc-lease-fencing@example.com';
      await User().deleteMany({ email });

      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);

      // Caller A claims the lease (PENDING -> PROVISIONING).
      const rowA = await PendingAuthRegistration().beginProvisioning(grantHash);
      if (!rowA) throw new Error('setup: expected beginProvisioning to succeed for A');
      const leaseTokenA = rowA.provisioningLeaseToken;
      expect(leaseTokenA).toEqual(expect.any(String));

      // Simulate A overrunning the 30s lease window while still genuinely
      // running (unaware) — force the lease to appear expired.
      await PendingAuthRegistration().updateOne({ _id: rowA._id }, { $set: { provisioningLeaseExpiresAt: new Date(Date.now() - 1000) } });

      // Caller B reclaims the now-expired lease and receives a DIFFERENT token.
      const rowB = await PendingAuthRegistration().beginProvisioning(grantHash);
      if (!rowB) throw new Error('setup: expected beginProvisioning to succeed for B (reclaim)');
      const leaseTokenB = rowB.provisioningLeaseToken;
      expect(leaseTokenB).toEqual(expect.any(String));
      expect(leaseTokenB).not.toBe(leaseTokenA);

      // A's own `finally` now runs its release with its STALE token — this
      // must NOT clear B's live lease.
      await PendingAuthRegistration().releaseProvisioningLease(rowA._id, leaseTokenA as string);
      const afterStaleRelease = await PendingAuthRegistration().findById(rowA._id);
      expect(afterStaleRelease?.provisioningLeaseToken).toBe(leaseTokenB);
      expect(afterStaleRelease?.provisioningLeaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());

      // A THIRD caller C must still be fenced out — B's lease (not A's
      // stale one) is the one genuinely live.
      const rowC = await PendingAuthRegistration().beginProvisioning(grantHash);
      expect(rowC).toBeNull();

      // A's own finalize write (fenced on ITS stale token) must not be able
      // to activate the row either, even though its OTHER CAS condition
      // (`state !== 'CANCELLED'`) would otherwise still match — this is the
      // exact filter shape `provisionClaimedRow` uses.
      const fencedFinalize = await PendingAuthRegistration().updateOne(
        { _id: rowA._id, state: { $ne: 'CANCELLED' }, provisioningLeaseToken: leaseTokenA },
        { $set: { state: 'ACTIVE', expiresAt: new Date(Date.now() + 1000) } },
      );
      expect(fencedFinalize.matchedCount).toBe(0);

      // B, the genuine current holder, releases properly — only THEN can C claim.
      await PendingAuthRegistration().releaseProvisioningLease(rowB._id, leaseTokenB as string);
      const rowC2 = await PendingAuthRegistration().beginProvisioning(grantHash);
      expect(rowC2).not.toBeNull();
    });

    it('AC-7: a caller whose lease is silently reclaimed mid-flight is fenced out of its own finalize write end-to-end — never reaches active even though its content-level checks would otherwise still pass', async () => {
      const provider = 'fedreg-svc-lease-fenced-finalize';
      const providerUserId = 'sub-lease-fenced-finalize';
      const email = 'svc-lease-fenced-finalize@example.com';
      const username = `svc-lease-fenced-finalize-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);

      // `ensurePendingMarker` is the LAST await before the guarded ACTIVE
      // finalize write (same injection point the deterministic logout-race
      // tests use above) — simulate the CURRENT call's lease expiring and a
      // NEW caller reclaiming it (and deliberately NOT releasing) strictly
      // before the current call's own finalize write runs.
      let staleLeaseToken: string | null = null;
      let reclaimedLeaseToken: string | null = null;
      const originalEnsurePendingMarker = UserActivation().ensurePendingMarker.bind(UserActivation());
      const activationSpy = jest.spyOn(UserActivation(), 'ensurePendingMarker').mockImplementationOnce(async (userId) => {
        await originalEnsurePendingMarker(userId);
        const row = await PendingAuthRegistration().findOne({ provider, providerUserId });
        if (!row) throw new Error('setup: row missing mid-test');
        staleLeaseToken = row.provisioningLeaseToken;
        await PendingAuthRegistration().updateOne({ _id: row._id }, { $set: { provisioningLeaseExpiresAt: new Date(Date.now() - 1000) } });
        const reclaimed = await PendingAuthRegistration().beginProvisioning(grantHash);
        if (!reclaimed) throw new Error('setup: expected the reclaim to succeed');
        reclaimedLeaseToken = reclaimed.provisioningLeaseToken;
        expect(reclaimedLeaseToken).not.toBe(staleLeaseToken);
        // Deliberately not released — its lease stays live for the rest of
        // this test.
      });

      try {
        const outcome = await provisionPendingRegistration(crowi, token, username);
        // The finalize write is fenced on the now-stale token — the row's
        // OTHER CAS condition (`state !== CANCELLED`) would otherwise still
        // have matched, but the lease-token filter does not.
        expect(outcome.kind).toBe('not_found');
      } finally {
        activationSpy.mockRestore();
      }

      const created = await User().findOne({ email });
      expect(created?.status).not.toBe(User().STATUS_ACTIVE);
      const row = await PendingAuthRegistration().findOne({ provider, providerUserId });
      // The reclaiming caller's lease is untouched by the original caller's
      // own (fenced, therefore no-op) release in its `finally`.
      expect(row?.provisioningLeaseToken).toBe(reclaimedLeaseToken);
    });

    it('AC-7: a caller whose lease is reclaimed AFTER its own finalize write already succeeded (it ran slow, not crashed) never reports active — single-winner even when the reclaim lands late', async () => {
      const provider = 'fedreg-svc-lease-post-finalize';
      const providerUserId = 'sub-lease-post-finalize';
      const email = 'svc-lease-post-finalize@example.com';
      const username = `svc-lease-post-finalize-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);

      // `User.updateOne` (the `userCas` write) is the ONLY call to that
      // method in `provisionClaimedRow`, and it runs strictly AFTER this
      // call's own fenced `finalized` write (journal -> ACTIVE) has ALREADY
      // succeeded — the exact injection point to simulate "this call ran
      // slow enough (past the 30s lease window, genuinely still in
      // progress, not crashed) for a NEW caller to legitimately reclaim the
      // lease" strictly between those two writes.
      let reclaimedLeaseToken: string | null = null;
      const UserModel = User();
      const originalUserUpdateOne = UserModel.updateOne.bind(UserModel);
      const updateSpy = jest.spyOn(UserModel, 'updateOne').mockImplementationOnce(async (filter, update) => {
        await PendingAuthRegistration().updateOne({ grantHash }, { $set: { provisioningLeaseExpiresAt: new Date(Date.now() - 1000) } });
        const reclaimed = await PendingAuthRegistration().beginProvisioning(grantHash);
        if (!reclaimed) throw new Error('setup: expected the reclaim to succeed');
        reclaimedLeaseToken = reclaimed.provisioningLeaseToken;
        // Deliberately not released — its lease stays live for the rest of
        // this test, modelling the reclaiming caller as still genuinely
        // running (or having just finished but not yet released).
        return originalUserUpdateOne(filter, update);
      });

      try {
        const outcome = await provisionPendingRegistration(crowi, token, username);
        // Fenced out by the reclaim that landed between its own finalize
        // write and the post-CAS re-check — never reports `active`, even
        // though its OWN journal write and its OWN User CAS both,
        // individually, already succeeded.
        expect(outcome.kind).toBe('not_found');
      } finally {
        updateSpy.mockRestore();
      }

      // The account itself is untouched by the fencing (the CAS is
      // idempotent) — the reclaiming caller is the one responsible for
      // completing the registration, never reverted out from under it.
      const created = await User().findOne({ email });
      expect(created?.status).toBe(User().STATUS_ACTIVE);
      const row = await PendingAuthRegistration().findOne({ provider, providerUserId });
      expect(row?.state).toBe('ACTIVE');
      expect(row?.provisioningLeaseToken).toBe(reclaimedLeaseToken);

      // The reclaiming caller (or a legitimate subsequent resume, once its
      // lease is released) genuinely finishes the SAME grant afterward —
      // exactly one winner overall, never zero.
      if (!row) throw new Error('setup: row missing after fencing');
      await PendingAuthRegistration().releaseProvisioningLease(row._id, reclaimedLeaseToken as string);
      const resumed = await provisionPendingRegistration(crowi, token, username);
      expect(resumed.kind).toBe('active');
      if (resumed.kind === 'active') {
        expect(String(resumed.user._id)).toBe(String(created?._id));
      }
    });

    it("AC-7: a lease reclaimed and fully drained by a SECOND caller strictly DURING this call's own activation drain is fenced out afterward — a lease check performed only BEFORE the drain (the prior design) would have already passed by this point and missed it, since the reclaim lands AFTER that check but the drain itself can outlive the 30s lease window", async () => {
      const provider = 'fedreg-svc-lease-during-drain';
      const providerUserId = 'sub-lease-during-drain';
      const email = 'svc-lease-during-drain@example.com';
      const username = `svc-lease-during-drain-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);

      // `UserActivation.claimActivationLease` is the FIRST call
      // `drainUserActivation` makes — caller A has already committed its
      // journal finalize write and User CAS by the time it gets here (a
      // check performed only BEFORE this call, the prior design, would
      // already have read A's own still-current token). Inject a SECOND,
      // genuinely concurrent caller B here: force A's `PendingAuthRegistration`
      // lease to appear expired, then run a COMPLETE
      // `provisionPendingRegistration` call for B to full completion
      // (reclaim -> resume -> its own drain -> its own fencing re-check ->
      // `active`) before letting A's own (real) drain proceed.
      let outcomeB: Awaited<ReturnType<typeof provisionPendingRegistration>> | null = null;
      const originalClaimActivationLease = UserActivation().claimActivationLease.bind(UserActivation());
      const claimSpy = jest.spyOn(UserActivation(), 'claimActivationLease').mockImplementationOnce(async (userId) => {
        await PendingAuthRegistration().updateOne({ grantHash }, { $set: { provisioningLeaseExpiresAt: new Date(Date.now() - 1000) } });
        outcomeB = await provisionPendingRegistration(crowi, token, username);
        // A's own drain proceeds normally afterward — B already claimed and
        // finished the `UserActivation` lease, so A's own claim attempt
        // finds the marker already `done` (mirrors the reported repro:
        // "caller A ... resumes and drains, it observes the marker already
        // done").
        return originalClaimActivationLease(userId);
      });

      let outcomeA: Awaited<ReturnType<typeof provisionPendingRegistration>>;
      try {
        outcomeA = await provisionPendingRegistration(crowi, token, username);
      } finally {
        claimSpy.mockRestore();
      }

      // Exactly ONE of the two calls reports `active` — the other is
      // fenced out, never both (AC-7 single-winner) — even though A's own
      // finalize write, User CAS, AND activation drain (observing the
      // marker already `done`) all, individually, ran to completion.
      expect(outcomeB?.kind).toBe('active');
      expect(outcomeA.kind).toBe('not_found');

      const created = await User().findOne({ email });
      expect(created?.status).toBe(User().STATUS_ACTIVE);
      const marker = await UserActivation().findOne({ userId: created?._id });
      expect(marker?.status).toBe('done');
      // B released its OWN lease in its own `finally` once it finished —
      // A's later, stale-token release call in ITS OWN `finally` is a
      // fenced no-op either way.
      const row = await PendingAuthRegistration().findOne({ provider, providerUserId });
      expect(row?.provisioningLeaseToken).toBeNull();
    });

    it('regression: a submit whose OWN reserved id was created by a concurrent winner strictly between its existingById check and its own pre-save conflict query converges on that SAME user, never a spurious conflict', async () => {
      // This deterministically reproduces the exact interleaving the
      // Promise.all test above only reproduces probabilistically: the
      // content-based pre-save check (`User.findOne({$or:[{email},{username}]})`)
      // must recognize a hit against ITS OWN reserved `userId` as itself
      // resolving, not a collision — otherwise a losing racer whose
      // `existingById` check ran before the winner committed, but whose
      // conflict check runs after, misreports `conflict` against a user
      // that IS the id it itself reserved.
      const provider = 'fedreg-svc-14';
      const providerUserId = 'sub-14';
      const email = 'svc-self-owned-conflict@example.com';
      const username = `svc-self-owned-conflict-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);

      // Pre-reserve the userId slot ourselves — as a concurrent winner's
      // CAS would have — so `provisionPendingRegistration` resumes with
      // this SAME id instead of running its own reservation branch.
      const beganRow = await moveToProvisioning(grantHash);
      if (!beganRow) throw new Error('setup: beginProvisioning did not return a row');
      const reservedUserId = new Types.ObjectId();
      const reserved = await PendingAuthRegistration().findOneAndUpdate({ _id: beganRow._id, userId: null }, { $set: { userId: reservedUserId } });
      expect(reserved).not.toBeNull();
      expect(await User().findById(reservedUserId)).toBeNull();

      const UserModel = User();
      // The ONLY `User.findOne` call inside `provisionPendingRegistration`
      // (for a not-yet-existing id) is `createUserForRegistration`'s
      // pre-save conflict check, which runs immediately after
      // `existingById` (a `findById`, unaffected by this spy) already
      // observed `null`. Committing the "concurrent winner"'s user HERE,
      // inside the one-time mock, deterministically places that commit
      // strictly between this call's own `existingById` (already run) and
      // its `conflict` query (about to run) — the exact gap the bug lived
      // in.
      const findOneSpy = jest.spyOn(UserModel, 'findOne').mockImplementationOnce(async (...args: Parameters<typeof UserModel.findOne>) => {
        const winner = new UserModel({
          name: 'Concurrent Winner',
          username,
          email,
          lang: 'en',
          status: UserModel.STATUS_REGISTERED,
          emailConfirmedAt: new Date(),
        });
        winner._id = reservedUserId;
        await winner.save();
        return UserModel.findOne(...args);
      });

      try {
        const outcome = await provisionPendingRegistration(crowi, token, username);
        expect(outcome.kind).toBe('active');
        if (outcome.kind === 'active') {
          expect(String(outcome.user._id)).toBe(String(reservedUserId));
        }
      } finally {
        findOneSpy.mockRestore();
      }

      expect(await UserModel.countDocuments({ email })).toBe(1);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(1);
    });

    it('an identity already linked to a different user is never moved (identity_conflict, no auto-link) and leaves NO orphaned User behind', async () => {
      const provider = 'fedreg-svc-6';
      const providerUserId = 'sub-6';
      const [userA] = (await Fixture.generate('User', [
        { name: faker.name.findName(), username: randomUsername(), email: faker.internet.email() },
      ])) as UserDocument[];
      await UserIdentity().create({ userId: userA._id, provider, providerUserId });

      // A grant issued directly on the model (bypassing the terminal's own
      // identity lookup) models the race the umbrella spec's design
      // decision 3 defends against: the identity was linked to someone
      // else BETWEEN grant issuance and submit.
      const email = 'svc-identity-conflict@example.com';
      const username = `svc-identity-conflict-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });
      const token = await PendingAuthRegistration().issueRegistrationGrant({
        provider,
        providerUserId,
        providerLabel: 'Google',
        profile: { email },
        handoffJkt: TEST_HANDOFF_JKT,
      });

      const outcome = await provisionPendingRegistration(crowi, token, username);
      expect(outcome.kind).toBe('identity_conflict');

      const identity = await UserIdentity().findOne({ provider, providerUserId });
      expect(String(identity?.userId)).toBe(String(userA._id));

      // AC-7: `createUserForRegistration` (called BEFORE `ensureIdentityLink`
      // in this state machine) already created/reserved a REGISTERED User
      // for this row's `userId` before the identity conflict was discovered
      // — it must be cleaned up, not left permanently squatting this
      // email/username with no linked identity and no way to ever sign in.
      expect(await User().countDocuments({ email })).toBe(0);
      expect(await User().countDocuments({ username })).toBe(0);
    });

    it('duplicate username across two DIFFERENT grants: the second submit gets a username conflict, not an auto-link', async () => {
      const provider = 'fedreg-svc-9';
      const emailA = 'svc-dup-username-a@example.com';
      const emailB = 'svc-dup-username-b@example.com';
      const sharedUsername = `svc-dup-username-${Date.now()}`;
      await User().deleteMany({ $or: [{ email: emailA }, { email: emailB }, { username: sharedUsername }] });

      const tokenA = await seedGrant(provider, 'sub-9a', emailA);
      const tokenB = await seedGrant(provider, 'sub-9b', emailB);

      const first = await provisionPendingRegistration(crowi, tokenA, sharedUsername);
      expect(first.kind).toBe('active');

      const second = await provisionPendingRegistration(crowi, tokenB, sharedUsername);
      expect(second.kind).toBe('conflict');
      if (second.kind === 'conflict') expect(second.field).toBe('username');

      expect(await User().countDocuments({ username: sharedUsername })).toBe(1);
      // No auto-link: the second grant's own identity was never created.
      expect(await UserIdentity().countDocuments({ provider, providerUserId: 'sub-9b' })).toBe(0);
    });

    it('duplicate email at submit time (race with an out-of-band account creation): conflict, no auto-link to the existing account', async () => {
      const provider = 'fedreg-svc-10';
      const providerUserId = 'sub-10';
      const email = 'svc-dup-email-race@example.com';
      const username = `svc-dup-email-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      // Issue the grant directly (bypassing the terminal's own pre-check),
      // then create the conflicting local account AFTER the grant already
      // exists — the exact race AC-7 defends against.
      const token = await PendingAuthRegistration().issueRegistrationGrant({
        provider,
        providerUserId,
        providerLabel: 'Google',
        profile: { email },
        handoffJkt: TEST_HANDOFF_JKT,
      });
      const [existing] = (await Fixture.generate('User', [{ name: 'Existing', username: `${username}-other`, email }])) as UserDocument[];

      const outcome = await provisionPendingRegistration(crowi, token, username);
      expect(outcome.kind).toBe('conflict');
      if (outcome.kind === 'conflict') expect(outcome.field).toBe('email');

      // No auto-link: the pre-existing account gained no federated identity.
      expect(await UserIdentity().countDocuments({ userId: existing._id })).toBe(0);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(0);
    });
  });

  describe('case-insensitive username/email uniqueness (matches USER_UNIQUE_COLLATION)', () => {
    it('a verified federated email that only differs by CASE from an existing local account is rejected as email_already_registered, never reaches the registration screen', async () => {
      const provider = 'fedreg-svc-case-email-terminal';
      const providerUserId = 'sub-case-email-terminal';
      const localEmail = 'svc-case-terminal@example.com';
      const idpEmail = 'SVC-Case-Terminal@Example.com';
      const [existing] = (await Fixture.generate('User', [{ name: faker.name.findName(), username: randomUsername(), email: localEmail }])) as UserDocument[];

      const result = await resolveProfile(provider, providerUserId, idpEmail);
      expect(result.kind).toBe('redirect_error');
      if (result.kind === 'redirect_error') expect(result.code).toBe('email_already_registered');

      // No PendingAuthRegistration row was minted for this attempt, and the
      // existing account gained no federated identity.
      expect(await PendingAuthRegistration().countDocuments({ provider, providerUserId })).toBe(0);
      expect(await UserIdentity().countDocuments({ userId: existing._id })).toBe(0);
    });

    it('duplicate EMAIL at submit time that only differs by case: conflict (field: email), never a silent duplicate account nor a misreported USERNAME_TAKEN', async () => {
      const provider = 'fedreg-svc-case-email-submit';
      const providerUserId = 'sub-case-email-submit';
      const localEmail = 'svc-case-submit@example.com';
      const idpEmail = 'SVC-Case-Submit@Example.com';
      const username = `svc-case-email-submit-${Date.now()}`;
      await User().deleteMany({ $or: [{ email: localEmail }, { username }] });

      // Issue the grant directly (bypassing the terminal's own pre-check,
      // same convention as the exact-case race test above) with the
      // DIFFERENTLY-cased email, then create the conflicting local account
      // with the LOWERCASE form after the grant already exists.
      const token = await PendingAuthRegistration().issueRegistrationGrant({
        provider,
        providerUserId,
        providerLabel: 'Google',
        profile: { email: idpEmail },
        handoffJkt: TEST_HANDOFF_JKT,
      });
      const [existing] = (await Fixture.generate('User', [{ name: 'Existing', username: `${username}-other`, email: localEmail }])) as UserDocument[];

      const outcome = await provisionPendingRegistration(crowi, token, username);
      expect(outcome.kind).toBe('conflict');
      if (outcome.kind === 'conflict') expect(outcome.field).toBe('email');

      // No new User was created for this attempt — the case-insensitive
      // pre-save check catches the collision before ever reaching
      // `User.save()`.
      expect(await User().countDocuments({ username })).toBe(0);
      expect(await UserIdentity().countDocuments({ userId: existing._id })).toBe(0);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(0);
    });

    it('duplicate USERNAME at submit time that only differs by case: conflict (field: username), the pre-save content-based check catches it before ever reaching User.save()', async () => {
      const provider = 'fedreg-svc-case-username-submit';
      const providerUserIdA = 'sub-case-username-submit-a';
      const providerUserIdB = 'sub-case-username-submit-b';
      const emailA = 'svc-case-username-a@example.com';
      const emailB = 'svc-case-username-b@example.com';
      const usernameLower = `svc-case-username-${Date.now()}`;
      const usernameUpper = usernameLower.toUpperCase();
      await User().deleteMany({ $or: [{ email: emailA }, { email: emailB }, { username: usernameLower }, { username: usernameUpper }] });

      const tokenA = await seedGrant(provider, providerUserIdA, emailA);
      const tokenB = await seedGrant(provider, providerUserIdB, emailB);

      const first = await provisionPendingRegistration(crowi, tokenA, usernameLower);
      expect(first.kind).toBe('active');

      // A DIFFERENTLY-cased username for a DIFFERENT grant/email must still
      // collide — the plain (non-collation) pre-save query used to miss
      // this and let `User.save()` raise its own E11000, which was then
      // misreported as `USERNAME_TAKEN` regardless of which field actually
      // collided (harmless here since it IS the username, but the fix
      // covers both fields via the SAME code path).
      const second = await provisionPendingRegistration(crowi, tokenB, usernameUpper);
      expect(second.kind).toBe('conflict');
      if (second.kind === 'conflict') expect(second.field).toBe('username');

      expect(await User().countDocuments({ $or: [{ username: usernameLower }, { username: usernameUpper }] })).toBe(1);
      expect(await UserIdentity().countDocuments({ provider, providerUserId: providerUserIdB })).toBe(0);
    });
  });

  describe('logout / submit race (AC-2 security)', () => {
    it('a logout racing with an in-flight submit never leaves an ACTIVE user behind a CANCELLED grant', async () => {
      const provider = 'fedreg-svc-11';
      const providerUserId = 'sub-11';
      const email = 'svc-logout-race@example.com';
      const username = `svc-logout-race-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);

      const [outcome] = await Promise.all([
        provisionPendingRegistration(crowi, token, username),
        PendingAuthRegistration().updateOne(
          { grantHash, state: { $in: ['PENDING', 'PROVISIONING'] } },
          { $set: { state: 'CANCELLED', expiresAt: new Date(Date.now() + 1000) } },
        ),
      ]);

      const row = await PendingAuthRegistration().findOne({ provider, providerUserId });
      const created = await User().findOne({ email });

      // `outcome.kind` is the authoritative signal of whether the state
      // machine's OWN finalize write genuinely committed — keying off it
      // (rather than the journal row's FINAL state) correctly covers a
      // third possible outcome the row's state alone can't distinguish: the
      // submit can win outright AND fully, durably complete (drain done)
      // strictly BEFORE the concurrent logout's own read runs, in which
      // case AC-2 now (correctly) lets the CANCEL stick — permanently
      // invalidating the grant — while the account itself stays ACTIVE
      // (logout never un-registers an already-completed account).
      if (outcome.kind === 'active') {
        expect(created?.status).toBe(User().STATUS_ACTIVE);
      } else {
        // The submit's finalize write was blocked by an earlier-landing
        // cancel (AC-2 security) — the row is CANCELLED and the account
        // never activated.
        expect(row?.state).toBe('CANCELLED');
        expect(created?.status).not.toBe(User().STATUS_ACTIVE);
      }
    });

    it('a logout that lands DETERMINISTICALLY between beginProvisioning and the guarded ACTIVE finalize write always blocks activation', async () => {
      const provider = 'fedreg-svc-12';
      const providerUserId = 'sub-12';
      const email = 'svc-logout-deterministic@example.com';
      const username = `svc-logout-deterministic-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);

      // Unlike the Promise.all race above (which tolerates either side
      // winning), this forces the interleave deterministically: `submit`
      // has already flipped PENDING→PROVISIONING (`beginProvisioning`),
      // created the User and identity, and reached the marker-creation
      // step — `ensurePendingMarker` is the LAST await before the guarded
      // finalize write — when the logout's CANCEL update is injected and
      // awaited BEFORE that finalize step ever runs.
      const originalEnsurePendingMarker = UserActivation().ensurePendingMarker.bind(UserActivation());
      const activationSpy = jest.spyOn(UserActivation(), 'ensurePendingMarker').mockImplementationOnce(async (userId) => {
        await originalEnsurePendingMarker(userId);
        const logoutResult = await PendingAuthRegistration().updateOne(
          { grantHash, state: { $in: ['PENDING', 'PROVISIONING'] } },
          { $set: { state: 'CANCELLED', expiresAt: new Date(Date.now() + 1000) } },
        );
        expect(logoutResult.modifiedCount).toBe(1);
      });

      try {
        const outcome = await provisionPendingRegistration(crowi, token, username);
        // The guarded finalize write's own query (`state: { $ne: 'CANCELLED' }`)
        // matches nothing once the logout above has already landed —
        // deterministically `not_found`, never `active`.
        expect(outcome.kind).toBe('not_found');
      } finally {
        activationSpy.mockRestore();
      }

      const row = await PendingAuthRegistration().findOne({ provider, providerUserId });
      expect(row?.state).toBe('CANCELLED');
      const created = await User().findOne({ email });
      expect(created?.status).not.toBe(User().STATUS_ACTIVE);
    });

    it('a logout that cancels the journal DETERMINISTICALLY between the journal write and the User CAS is caught by the compensating post-CAS re-check, reverting the User CAS this call itself performed', async () => {
      const provider = 'fedreg-svc-13';
      const providerUserId = 'sub-13';
      const email = 'svc-logout-post-journal-active@example.com';
      const username = `svc-logout-post-journal-active-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);

      // The journal's OWN finalize write (`state:'ACTIVE'`) runs strictly
      // BEFORE the User's ACTIVE CAS — `User.updateOne` is therefore the
      // ONLY call to that method in a fresh, non-restricted,
      // non-concurrent submit, making it the exact injection point for "a
      // logout lands AFTER the journal write but BEFORE the User CAS
      // actually executes".
      const UserModel = User();
      const originalUserUpdateOne = UserModel.updateOne.bind(UserModel);
      const updateSpy = jest.spyOn(UserModel, 'updateOne').mockImplementationOnce(async (filter, update) => {
        const logoutResult = await PendingAuthRegistration().updateOne(
          { grantHash, state: 'ACTIVE' },
          { $set: { state: 'CANCELLED', expiresAt: new Date(Date.now() + 1000) } },
        );
        expect(logoutResult.modifiedCount).toBe(1);
        return originalUserUpdateOne(filter, update);
      });

      try {
        const outcome = await provisionPendingRegistration(crowi, token, username);
        // The User CAS this mock wraps still executes (and, in isolation,
        // succeeds — the User was still REGISTERED at that instant) — but
        // the compensating post-CAS re-check sees the journal is now
        // CANCELLED and reverts it: `not_found`, never `active`.
        expect(outcome.kind).toBe('not_found');
      } finally {
        updateSpy.mockRestore();
      }

      const row = await PendingAuthRegistration().findOne({ provider, providerUserId });
      expect(row?.state).toBe('CANCELLED');
      const created = await User().findOne({ email });
      // Reverted by the compensating check — never left ACTIVE behind a
      // CANCELLED journal, even though the CAS itself momentarily succeeded.
      expect(created?.status).toBe(User().STATUS_REGISTERED);
    });

    it('AC-2/AC-8: a CANCELLED row REVIVED by a fresh re-auth clears the stale lease from a PRIOR, still-in-flight submit — that submit is fenced out of its finalize write instead of completing with a stale handoffJkt (regression: revival used to preserve provisioningLeaseToken/provisioningLeaseExpiresAt untouched)', async () => {
      const provider = 'fedreg-svc-15';
      const providerUserId = 'sub-15';
      const email = 'svc-logout-revive-fencing@example.com';
      const username = `svc-logout-revive-fencing-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);

      // The OLD submit's finalize write runs strictly AFTER
      // `ensurePendingMarker` — inject the logout + revive sequence right
      // there, the same technique the deterministic tests above use.
      let reissuedToken: string | null = null;
      const originalEnsurePendingMarker = UserActivation().ensurePendingMarker.bind(UserActivation());
      const activationSpy = jest.spyOn(UserActivation(), 'ensurePendingMarker').mockImplementationOnce(async (userId) => {
        await originalEnsurePendingMarker(userId);

        // Logout cancels the row — `userId` stays reserved (logout never
        // touches it), which is what makes the SUBSEQUENT re-auth below a
        // REVIVE, not a FRESH reset.
        const logoutResult = await PendingAuthRegistration().updateOne(
          { grantHash, state: { $ne: 'CANCELLED' } },
          { $set: { state: 'CANCELLED', expiresAt: new Date(Date.now() + 1000) } },
        );
        expect(logoutResult.modifiedCount).toBe(1);

        // A fresh re-auth for the SAME provider identity revives the row
        // with a NEW grant + handoffJkt.
        reissuedToken = await PendingAuthRegistration().issueRegistrationGrant({
          provider,
          providerUserId,
          providerLabel: 'Google',
          profile: { email },
          handoffJkt: 'revived-handoff-jkt',
        });
        const revivedRow = await PendingAuthRegistration().findOne({ provider, providerUserId });
        expect(revivedRow?.state).toBe('PROVISIONING');
        // The fix under test: the OLD submit's lease must be CLEARED by the
        // revive, not merely left in place for a stale finalize write to
        // still match once `state !== 'CANCELLED'` holds again.
        expect(revivedRow?.provisioningLeaseToken).toBeNull();
        expect(revivedRow?.provisioningLeaseExpiresAt).toBeNull();
      });

      try {
        const outcome = await provisionPendingRegistration(crowi, token, username);
        // The OLD submit's finalize write is fenced out by the now-cleared
        // lease token — `not_found`, never `active` with the STALE
        // handoffJkt captured before the revive rotated it.
        expect(outcome.kind).toBe('not_found');
      } finally {
        activationSpy.mockRestore();
      }

      const created = await User().findOne({ email });
      expect(created?.status).not.toBe(User().STATUS_ACTIVE);

      // The fencing fix must not strand the legitimately re-authenticated
      // visitor either — the revived grant is genuinely usable afterwards
      // and converges on the SAME (already-reserved) User.
      if (!reissuedToken) throw new Error('setup: expected a reissued token from the revive');
      const resumed = await provisionPendingRegistration(crowi, reissuedToken, username);
      expect(resumed.kind).toBe('active');
      if (resumed.kind === 'active') {
        expect(String(resumed.user._id)).toBe(String(created?._id));
        expect(resumed.handoffJkt).toBe('revived-handoff-jkt');
      }
    });

    it('AC-2/AC-8: a logout landing BEFORE the userId reservation, followed by a fresh re-auth reset (not a revive), fences the OLD submit out of its OWN userId reservation — no phantom User/UserIdentity, and the reissued grant is fully usable afterwards', async () => {
      const provider = 'fedreg-svc-16';
      const providerUserId = 'sub-16';
      const email = 'svc-logout-fresh-fencing@example.com';
      const oldUsername = `svc-logout-fresh-fencing-old-${Date.now()}`;
      const newUsername = `svc-logout-fresh-fencing-new-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username: oldUsername }, { username: newUsername }] });

      const token = await seedGrant(provider, providerUserId, email);
      const grantHash = PendingAuthRegistration().hashGrant(token);

      // Inject strictly between `beginProvisioning` claiming the lease and
      // `provisionClaimedRow`'s own userId-reservation CAS — the row this
      // OLD submit captured has `userId: null` at this point (nothing
      // reserved yet), which is exactly what makes the race a FRESH reset
      // on revival, not a REVIVE (unlike the sibling test above, whose
      // injection point runs AFTER userId is already reserved).
      let reissuedToken: string | null = null;
      const originalBeginProvisioning = PendingAuthRegistration().beginProvisioning.bind(PendingAuthRegistration());
      const beginSpy = jest.spyOn(PendingAuthRegistration(), 'beginProvisioning').mockImplementationOnce(async (hash: string) => {
        const claimed = await originalBeginProvisioning(hash);

        // Logout cancels the row — `userId` is still `null` at this point
        // (the OLD submit hasn't reserved one yet), so the row's grantHash
        // match below is a genuine `CANCELLED`+`userId: null` shape.
        const logoutResult = await PendingAuthRegistration().updateOne(
          { grantHash, state: { $ne: 'CANCELLED' } },
          { $set: { state: 'CANCELLED', expiresAt: new Date(Date.now() + 1000) } },
        );
        expect(logoutResult.modifiedCount).toBe(1);

        // A fresh re-auth for the SAME provider identity resets the row —
        // `issueRegistrationGrant`'s FRESH branch (not REVIVE), since no
        // `userId` was ever reserved.
        reissuedToken = await PendingAuthRegistration().issueRegistrationGrant({
          provider,
          providerUserId,
          providerLabel: 'Google',
          profile: { email },
          handoffJkt: 'fresh-reset-handoff-jkt',
        });
        const revivedRow = await PendingAuthRegistration().findOne({ provider, providerUserId });
        expect(revivedRow?.state).toBe('PENDING');
        expect(revivedRow?.userId).toBeNull();
        // The fix under test: the FRESH branch must clear the OLD submit's
        // stale lease too, not just the REVIVE branch.
        expect(revivedRow?.provisioningLeaseToken).toBeNull();
        expect(revivedRow?.provisioningLeaseExpiresAt).toBeNull();

        return claimed;
      });

      try {
        const outcome = await provisionPendingRegistration(crowi, token, oldUsername);
        // Fenced out at the userId-reservation CAS itself (the lease no
        // longer matches) — never reaches `active`, and never fabricates a
        // `userId` to fall back to.
        expect(outcome.kind).toBe('not_found');
      } finally {
        beginSpy.mockRestore();
      }

      // No phantom account for the OLD submit's username.
      expect(await User().countDocuments({ username: oldUsername })).toBe(0);
      expect(await UserIdentity().countDocuments({ provider, providerUserId })).toBe(0);

      // The freshly reset grant is fully usable by the legitimately
      // re-authenticated visitor, with THEIR OWN chosen username — not
      // silently overridden by anything the fenced-out OLD submit did.
      if (!reissuedToken) throw new Error('setup: expected a reissued token from the fresh reset');
      const resumed = await provisionPendingRegistration(crowi, reissuedToken, newUsername);
      expect(resumed.kind).toBe('active');
      if (resumed.kind === 'active') {
        expect(resumed.user.username).toBe(newUsername);
        expect(resumed.handoffJkt).toBe('fresh-reset-handoff-jkt');
      }
    });
  });
});
