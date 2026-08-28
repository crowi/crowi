import { crowi } from 'src/test/setup';

describe('User', () => {
  let Page;
  let User;

  beforeAll(() => {
    Page = crowi.model('Page');
    User = crowi.model('User');
  });

  describe('Create and Find.', () => {
    describe('The user', () => {
      // A unique fixture per run so these three tests own their user and the
      // partial-email query below can filter on the exact known address rather
      // than depending on the first array element (which is order-fragile once
      // other blocks seed users whose email also contains the substring).
      const suffix = Date.now().toString(36);
      const username = `aoi-${suffix}`;
      const email = `aoi-${suffix}@example.com`;

      beforeAll(async () => {
        await new Promise<void>((resolve, reject) => {
          User.createUserByEmailAndPassword('Aoi Miyazaki', username, email, 'hogefuga11', 'en', (err, userData) => {
            if (err) return reject(err);
            try {
              expect(userData).toBeInstanceOf(User);
              resolve();
            } catch (e) {
              reject(e);
            }
          });
        });
      });

      afterAll(async () => {
        await User.deleteOne({ email });
      });

      test('should be found by findUserByUsername', async () => {
        const userData = await User.findUserByUsername(username);
        expect(userData).toBeInstanceOf(User);
        expect(userData.email).toBe(email);
      });

      test('should be found by findUsersByPartOfEmail (filtered by the exact known email)', async () => {
        // Query by the substring (exercises the partial-match regex), then
        // select the row by its known email instead of relying on `[0]`.
        const userData = await User.findUsersByPartOfEmail(`aoi-${suffix}`, {});
        const found = userData.find((u: { email: string }) => u.email === email);
        expect(found).toBeInstanceOf(User);
        expect(found.email).toBe(email);
      });
    });
  });

  // These statics used mongoose-6 callback queries (save / findById / remove)
  // that mongoose 7 removed; they were migrated to the promise form while
  // keeping their public (err, data) callback signature. Exercise that the
  // bridge still resolves the callback correctly on mongoose 8.
  describe('Callback-form statics migrated off mongoose-7-removed queries', () => {
    test('makeAdmin saves and yields the updated doc with a null error', () => {
      return new Promise<void>((resolve, reject) => {
        User.createUserByEmailAndPassword('Admin Cand', 'admincand', 'admincand@example.com', 'hogefuga11', 'en', function (createErr, created) {
          if (createErr) return reject(createErr);
          created.makeAdmin(function (err, userData) {
            try {
              expect(err).toBeNull();
              expect(userData.admin).toBe(true);
              resolve();
            } catch (e) {
              reject(e);
            }
          });
        });
      });
    });

    test('removeCompletelyById physically deletes an INVITED user via deleteOne', async () => {
      const invited = new User();
      invited.email = 'invitee@example.com';
      invited.setPassword('hogefuga11');
      invited.status = User.STATUS_INVITED;
      await invited.save();

      await new Promise<void>((resolve, reject) => {
        User.removeCompletelyById(invited._id, (err, result) => {
          if (err) return reject(err);
          try {
            expect(result).toBe(1);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });

      const after = await User.findById(invited._id);
      expect(after).toBeNull();
    });

    test('removeCompletelyById refuses to physically delete a non-INVITED user', async () => {
      const active = new User();
      active.email = 'active-keep@example.com';
      active.setPassword('hogefuga11');
      active.status = User.STATUS_ACTIVE;
      await active.save();

      await new Promise<void>((resolve) => {
        User.removeCompletelyById(active._id, (err, result) => {
          expect(err).toBeInstanceOf(Error);
          expect(result).toBeNull();
          resolve();
        });
      });

      const after = await User.findById(active._id);
      expect(after).not.toBeNull();
    });
  });

  describe('Session revocation counters', () => {
    // `authVersion` / `passwordResetGeneration` are bumped with `$inc` from
    // one request while other requests may be holding a doc hydrated
    // beforehand. They therefore must NOT carry a mongoose `default`:
    // a default applied at hydration is persisted on the next save() (it
    // rides along in the delta even though isModified() reports false),
    // which would write the counter back to 0 and resurrect exactly the
    // sessions a password change had just revoked.
    test('a save from a stale doc cannot roll a bumped counter back', async () => {
      const user = new User();
      user.email = `revocation-counter-${Date.now().toString(36)}@example.com`;
      user.setPassword('hogefuga11');
      user.status = User.STATUS_ACTIVE;
      await user.save();

      // Make it a genuine pre-migration row: both paths ABSENT, not stored
      // as 0. This is the whole point of the test — a schema `default` only
      // gets applied (and then persisted by the next save) when the path is
      // missing at hydration, so a fixture that already stores 0 would pass
      // whether or not somebody re-added the default, proving nothing.
      await User.collection.updateOne({ _id: user._id }, { $unset: { authVersion: '', passwordResetGeneration: '' } });

      // A request that loaded the user before the password change.
      const stale = await User.findById(user._id);

      // The password change, from another request.
      await User.updateOne({ _id: user._id }, { $inc: { authVersion: 1, passwordResetGeneration: 1 } });

      // The in-flight request finishes and writes its own (unrelated) edit.
      stale.name = 'Renamed after the change';
      await stale.save();

      const reloaded = await User.findById(user._id);
      expect(reloaded.authVersion).toBe(1);
      expect(reloaded.passwordResetGeneration).toBe(1);
    });
  });

  // feature-federated-admin-identity-management — the admin unlink route
  // (DELETE /admin/users/:id/identities/:provider) issues a password for a
  // passwordless account so it keeps a way to sign in after the identity is
  // removed. A separate isPasswordSet() read followed by a plain write would
  // let two concurrent unlinks both observe "no password" and both write a
  // DIFFERENT one, leaving one response holding a value that is not what
  // actually got stored (the review-flagged concurrent-unlink race).
  describe('issuePasswordIfUnset (feature-federated-admin-identity-management)', () => {
    test('issues a password for a user with none, and is a no-op for a user who already has one', async () => {
      const user = new User();
      user.email = `issue-pw-${Date.now().toString(36)}@example.com`;
      user.status = User.STATUS_ACTIVE;
      await user.save();
      expect(user.password).toBeUndefined();

      const first = await User.issuePasswordIfUnset(user._id);
      expect(first.passwordIssued).toBe(true);
      expect(typeof first.newPassword).toBe('string');
      const reloaded = await User.findById(user._id).select('+password');
      expect(reloaded.isPasswordValid(first.newPassword)).toBe(true);

      const second = await User.issuePasswordIfUnset(user._id);
      expect(second.passwordIssued).toBe(false);
      expect(second.newPassword).toBeUndefined();
      const stillReloaded = await User.findById(user._id).select('+password');
      // The second (no-op) call must not have overwritten the first password.
      expect(stillReloaded.isPasswordValid(first.newPassword)).toBe(true);
    });

    test('exactly one of two concurrent calls issues the password that ends up stored', async () => {
      const user = new User();
      user.email = `issue-pw-race-${Date.now().toString(36)}@example.com`;
      user.status = User.STATUS_ACTIVE;
      await user.save();

      const [a, b] = await Promise.all([User.issuePasswordIfUnset(user._id), User.issuePasswordIfUnset(user._id)]);

      const issued = [a, b].filter((r) => r.passwordIssued);
      const notIssued = [a, b].filter((r) => !r.passwordIssued);
      expect(issued.length).toBe(1);
      expect(notIssued.length).toBe(1);
      expect(notIssued[0].newPassword).toBeUndefined();

      const reloaded = await User.findById(user._id).select('+password');
      expect(reloaded.isPasswordValid(issued[0].newPassword)).toBe(true);
    });
  });

  describe('Username validation (feature-username-validation-contract)', () => {
    test('rejects a document save when username is set to a non-conforming value', async () => {
      const user = new User();
      user.email = `bad-username-${Date.now().toString(36)}@example.com`;
      user.setPassword('hogefuga11');
      user.username = 'bad name!';
      await expect(user.save()).rejects.toThrow();
    });

    test('accepts 1-char and 64-char boundary usernames on save', async () => {
      const shortUser = new User();
      shortUser.email = `boundary-min-${Date.now().toString(36)}@example.com`;
      shortUser.setPassword('hogefuga11');
      shortUser.username = 'q';
      await expect(shortUser.save()).resolves.toBeInstanceOf(User);

      const longUsername = 'q'.repeat(64);
      const longUser = new User();
      longUser.email = `boundary-max-${Date.now().toString(36)}@example.com`;
      longUser.setPassword('hogefuga11');
      longUser.username = longUsername;
      await expect(longUser.save()).resolves.toBeInstanceOf(User);

      await User.deleteMany({ _id: { $in: [shortUser._id, longUser._id] } });
    });

    test('createUserByEmailAndPassword rejects a non-conforming username', async () => {
      await new Promise<void>((resolve, reject) => {
        User.createUserByEmailAndPassword('Bad User', 'bad name', `create-bad-${Date.now().toString(36)}@example.com`, 'hogefuga11', 'en', (err) => {
          try {
            expect(err).toBeInstanceOf(Error);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
    });

    test('isRegisterableUsername returns not-registerable for a non-conforming username without querying the DB', async () => {
      const findOneSpy = jest.spyOn(User, 'findOne');
      try {
        await new Promise<void>((resolve) => {
          User.isRegisterableUsername('bad name!', (registerable) => {
            expect(registerable).toBe(false);
            resolve();
          });
        });
        expect(findOneSpy).not.toHaveBeenCalled();
      } finally {
        findOneSpy.mockRestore();
      }
    });

    test('isRegisterable returns username: false for a non-conforming username without querying the DB for username or email', async () => {
      const findOneSpy = jest.spyOn(User, 'findOne');
      try {
        await new Promise<void>((resolve) => {
          User.isRegisterable(`isregisterable-${Date.now().toString(36)}@example.com`, 'bad name!', (registerable, detail) => {
            expect(registerable).toBe(false);
            expect(detail.username).toBe(false);
            resolve();
          });
        });
        expect(findOneSpy).not.toHaveBeenCalled();
      } finally {
        findOneSpy.mockRestore();
      }
    });
  });

  describe('Legacy / invited username rows are not retroactively invalidated (feature-username-validation-contract AC-4)', () => {
    test('a STATUS_INVITED row with no username saves without error', async () => {
      const invited = new User();
      invited.email = `invited-no-username-${Date.now().toString(36)}@example.com`;
      invited.setPassword('hogefuga11');
      invited.status = User.STATUS_INVITED;
      await expect(invited.save()).resolves.toBeInstanceOf(User);
      expect(invited.username).toBeUndefined();

      await User.deleteOne({ _id: invited._id });
    });

    test('saving an existing document with a legacy non-conforming username unchanged does not fail, and the username is not modified', async () => {
      const user = new User();
      user.email = `legacy-bad-username-${Date.now().toString(36)}@example.com`;
      user.setPassword('hogefuga11');
      await user.save();

      // Write a legacy-shaped non-conforming username directly at the
      // collection level, bypassing the Mongoose validator — simulating a
      // pre-existing row that predates this contract.
      await User.collection.updateOne({ _id: user._id }, { $set: { username: 'legacy bad name!' } });

      const reloaded = await User.findById(user._id);
      expect(reloaded?.username).toBe('legacy bad name!');

      // A save that changes an unrelated field must succeed without being
      // rejected on account of the still-non-conforming (but unchanged)
      // username.
      reloaded.name = 'Renamed Legacy User';
      await expect(reloaded.save()).resolves.toBeInstanceOf(User);

      const afterSave = await User.findById(user._id);
      expect(afterSave?.username).toBe('legacy bad name!');
      expect(afterSave?.name).toBe('Renamed Legacy User');

      await User.deleteOne({ _id: user._id });
    });
  });

  describe('createUsersByInvitation', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('AC-4: processes multiple emails concurrently rather than one at a time', async () => {
      const emails = ['par1@example.com', 'par2@example.com', 'par3@example.com'];
      const pendingResolvers: (() => void)[] = [];
      let inFlight = 0;
      let maxInFlight = 0;

      // Each findOne() call parks on its own deferred promise instead of
      // resolving immediately, so a sequential (one-at-a-time) implementation
      // would only ever have 1 call in flight while a concurrent one issues
      // all of them before any resolves.
      const findOneSpy = jest.spyOn(User, 'findOne').mockImplementation(
        () =>
          new Promise((resolve) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            pendingResolvers.push(() => {
              inFlight -= 1;
              // Truthy resolution takes the "user already exists" branch,
              // which needs no further DB interaction (no save()).
              resolve({ _id: 'existing' });
            });
          }) as unknown as ReturnType<typeof User.findOne>,
      );

      const resultPromise = new Promise<{ email: string; password: string | null; user: unknown }[]>((resolve, reject) => {
        User.createUsersByInvitation(emails, false, (err: Error | null, list: { email: string; password: string | null; user: unknown }[]) => {
          if (err) return reject(err);
          resolve(list);
        });
      });

      // Let the microtask queue advance so every findOne() call in the
      // Promise.all(...map...) has been issued before any of them resolves.
      await new Promise((r) => setImmediate(r));

      expect(findOneSpy).toHaveBeenCalledTimes(emails.length);
      expect(maxInFlight).toBe(emails.length);

      while (pendingResolvers.length > 0) {
        pendingResolvers.pop()?.();
      }

      const list = await resultPromise;
      expect(list).toHaveLength(emails.length);
    });
  });

  describe('User Utilities', () => {
    describe('Get username from path', () => {
      test('found', () => {
        return new Promise<void>((resolve) => {
          let username = null;
          username = User.getUsernameByPath('/user/sotarok');
          expect(username).toBe('sotarok');

          username = User.getUsernameByPath('/user/some.user.name12/'); // with slash
          expect(username).toBe('some.user.name12');

          resolve();
        });
      });

      test('not found', () => {
        return new Promise<void>((resolve) => {
          let username = null;
          username = User.getUsernameByPath('/the/page/is/not/related/to/user/page');
          expect(username).toBeNull();

          resolve();
        });
      });
    });
  });
});
