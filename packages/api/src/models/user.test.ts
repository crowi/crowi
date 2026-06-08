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
