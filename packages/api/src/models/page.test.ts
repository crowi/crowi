import { Types } from 'mongoose';
import { STATUS_DELETED, visiblePageGrantOr } from 'src/models/page';
import { crowi, Fixture } from 'src/test/setup';

describe('Page', () => {
  let Page;
  let User;
  let createdPages;
  let createdUsers;

  beforeAll((done) => {
    Page = crowi.model('Page');
    User = crowi.model('User');

    Promise.resolve()
      .then(() => {
        const userFixture = [
          { name: 'Anon 0', username: 'anonymous0', email: 'anonymous0@example.com' },
          { name: 'Anon 1', username: 'anonymous1', email: 'anonymous1@example.com' },
        ];

        return Fixture.generate('User', userFixture);
      })
      .then((testUsers) => {
        createdUsers = testUsers;
        const testUser0 = testUsers[0];

        const fixture = [
          {
            path: '/user/anonymous/memo',
            grant: Page.GRANT_RESTRICTED,
            grantedUsers: [testUser0],
            creator: testUser0,
          },
          {
            path: '/grant/public',
            grant: Page.GRANT_PUBLIC,
            grantedUsers: [testUser0],
            creator: testUser0,
          },
          {
            path: '/grant/restricted',
            grant: Page.GRANT_RESTRICTED,
            grantedUsers: [testUser0],
            creator: testUser0,
          },
          {
            path: '/grant/specified',
            grant: Page.GRANT_SPECIFIED,
            grantedUsers: [testUser0],
            creator: testUser0,
          },
          {
            path: '/grant/owner',
            grant: Page.GRANT_OWNER,
            grantedUsers: [testUser0],
            creator: testUser0,
          },
          {
            path: '/page/for/extended',
            grant: Page.GRANT_PUBLIC,
            creator: testUser0,
            extended: { hoge: 1 },
          },
        ];

        return Fixture.generate('Page', fixture).then((pages) => {
          createdPages = pages;
          done();
        });
      });
  });

  describe('.isPublic', () => {
    describe('with a public page', () => {
      test('should return true', async () => {
        const page = await Page.findOne({ path: '/grant/public' });
        expect(page.isPublic()).toBe(true);
      });
    });
    ['restricted', 'specified', 'owner'].forEach((grant) => {
      describe('with a ' + grant + ' page', () => {
        test('should return false', async () => {
          const page = await Page.findOne({ path: '/grant/' + grant });
          expect(page.isPublic()).toBe(false);
        });
      });
    });
  });

  describe('.getDeletedPageName', () => {
    test('should return trash page name', () => {
      expect(Page.getDeletedPageName('/hoge')).toBe('/trash/hoge');
      expect(Page.getDeletedPageName('hoge')).toBe('/trash/hoge');
    });
  });
  describe('.getRevertDeletedPageName', () => {
    test('should return reverted trash page name', () => {
      expect(Page.getRevertDeletedPageName('/hoge')).toBe('/hoge');
      expect(Page.getRevertDeletedPageName('/trash/hoge')).toBe('/hoge');
      expect(Page.getRevertDeletedPageName('/trash/hoge/trash')).toBe('/hoge/trash');
    });
  });

  describe('.isDeletableName', () => {
    test('should decide deletable or not', () => {
      expect(Page.isDeletableName('/hoge')).toBe(true);
      expect(Page.isDeletableName('/user/xxx')).toBe(false);
      expect(Page.isDeletableName('/user/xxx123')).toBe(false);
      // The trailing-slash variant is the same user-home portal page, guarded
      // since the rename/delete bypass fix (USER_HOME_PAGE_PATH allows `/?$`).
      expect(Page.isDeletableName('/user/xxx/')).toBe(false);
      expect(Page.isDeletableName('/user/xxx/hoge')).toBe(true);
    });
  });

  describe('.isCreatableName', () => {
    test('should decide creatable or not', () => {
      expect(Page.isCreatableName('/hoge')).toBe(true);

      // edge cases
      expect(Page.isCreatableName('/me')).toBe(false);
      expect(Page.isCreatableName('/me/')).toBe(false);
      expect(Page.isCreatableName('/me/x')).toBe(false);
      expect(Page.isCreatableName('/meeting')).toBe(true);
      expect(Page.isCreatableName('/meeting/x')).toBe(true);

      // end with "edit"
      expect(Page.isCreatableName('/meeting/edit')).toBe(false);

      // under score
      expect(Page.isCreatableName('/_')).toBe(false);
      expect(Page.isCreatableName('/_r/x')).toBe(false);
      expect(Page.isCreatableName('/_api')).toBe(false);
      expect(Page.isCreatableName('/_apix')).toBe(false);
      expect(Page.isCreatableName('/_api/x')).toBe(false);

      expect(Page.isCreatableName('/hoge/xx.md')).toBe(false);

      // start with https?
      expect(Page.isCreatableName('/http://demo.crowi.wiki/user/sotarok/hoge')).toBe(false);
      expect(Page.isCreatableName('/https://demo.crowi.wiki/user/sotarok/hoge')).toBe(false);
      expect(Page.isCreatableName('http://demo.crowi.wiki/user/sotarok/hoge')).toBe(false);
      expect(Page.isCreatableName('https://demo.crowi.wiki/user/sotarok/hoge')).toBe(false);

      expect(Page.isCreatableName('/ the / path / with / space')).toBe(false);

      let forbidden: string[] = [];
      forbidden = ['installer', 'register', 'login', 'logout', 'admin', 'files', 'trash', 'paste', 'comments', 'api'];
      for (let i = 0; i < forbidden.length; i++) {
        const pn = forbidden[i];
        expect(Page.isCreatableName('/' + pn + '')).toBe(false);
        expect(Page.isCreatableName('/' + pn + '/')).toBe(false);
        expect(Page.isCreatableName('/' + pn + '/abc')).toBe(false);
      }
      // the prefix match is segment-bounded — `/apiary` is a real word, not
      // the `/api` namespace.
      expect(Page.isCreatableName('/apiary')).toBe(true);

      forbidden = ['bookmarks', 'comments', 'activities', 'pages', 'recent-create', 'recent-edit'];
      for (let i = 0; i < forbidden.length; i++) {
        const pn = forbidden[i];
        expect(Page.isCreatableName('/user/aoi/' + pn)).toBe(false);
        expect(Page.isCreatableName('/user/aoi/x/' + pn)).toBe(true);
      }

      // `/user` and `/user/` are the member directory — no portal/page here,
      // but individual user pages (and their sub-portals) stay creatable.
      expect(Page.isCreatableName('/user')).toBe(false);
      expect(Page.isCreatableName('/user/')).toBe(false);
      expect(Page.isCreatableName('/user/aoi')).toBe(true);
      expect(Page.isCreatableName('/user/aoi/')).toBe(true);
    });
  });

  describe('.isCreator', () => {
    describe('with creator', () => {
      test('should return true', async () => {
        const page = await Page.findOne({ path: '/user/anonymous/memo' });

        const user = await User.findOne({ email: 'anonymous0@example.com' });
        expect(page.isCreator(user)).toBe(true);

        const user1 = await User.findOne({ email: 'anonymous1@example.com' });
        expect(page.isCreator(user1)).toBe(false);
      });
    });
  });

  describe('.isGrantedFor', () => {
    describe('with a granted user', () => {
      test('should return true', async () => {
        const user = await User.findOne({ email: 'anonymous0@example.com' });
        const page = await Page.findOne({ path: '/user/anonymous/memo' });
        expect(page.isGrantedFor(user)).toBe(true);
      });
    });

    describe('with a public page', () => {
      test('should return true', async () => {
        const user = await User.findOne({ email: 'anonymous1@example.com' });
        const page = await Page.findOne({ path: '/grant/public' });
        expect(page.isGrantedFor(user)).toBe(true);
      });
    });

    describe('with a restricted page and an user who has no grant', () => {
      test('should return false', async () => {
        const user = await User.findOne({ email: 'anonymous1@example.com' });
        const page = await Page.findOne({ path: '/grant/restricted' });
        expect(page.isGrantedFor(user)).toBe(false);
      });
    });

    describe('with a populated grantedUsers array', () => {
      test('should return true for a member found via ObjectId value equality, not reference identity', async () => {
        const user = await User.findOne({ email: 'anonymous0@example.com' });
        const page = await Page.findOne({ path: '/grant/restricted' }).populate('grantedUsers');
        // `user` and the populated `grantedUsers` entries are distinct
        // document instances loaded from separate queries — `indexOf`
        // (reference/primitive comparison) would fail to match them even
        // though the underlying ObjectId is the same value.
        expect(page.grantedUsers[0]).not.toBe(user);
        expect(page.isGrantedFor(user)).toBe(true);
      });
    });
  });

  describe('Extended field', () => {
    describe('Slack Channel.', () => {
      test('should be empty', async () => {
        const page = await Page.findOne({ path: '/page/for/extended' });
        expect(page.extended.hoge).toBe(1);
        expect(page.getSlackChannel()).toBe('');
      });

      test('set slack channel and should get it and should keep hoge ', async () => {
        const page = await Page.findOne({ path: '/page/for/extended' });
        await page.updateSlackChannel('slack-channel1');

        expect(page.extended.hoge).toBe(1);
        expect(page.getSlackChannel()).toBe('slack-channel1');
      });
    });
  });

  describe('RFC-0003 collab fields', () => {
    test('new pages default currentRevision / yjsState / yjsCheckpointAt to null', async () => {
      // Phase 1 only adds the schema fields; the Phase 5 save flow
      // writes them. Until then a freshly-created page must surface
      // them as `null` so callers can branch on "no live state yet".
      const page = await Page.findOne({ path: '/grant/public' });
      expect(page.currentRevision).toBeNull();
      expect(page.yjsState).toBeNull();
      expect(page.yjsCheckpointAt).toBeNull();
    });

    test('round-trips a Buffer yjsState write through Mongo', async () => {
      const page = await Page.findOne({ path: '/grant/public' });
      const snapshot = Buffer.from([0xaa, 0xbb, 0xcc]);
      page.yjsState = snapshot;
      page.yjsCheckpointAt = new Date('2026-05-14T00:00:00Z');
      await page.save();

      const reloaded = await Page.findById(page._id);
      const asBuffer = Buffer.isBuffer(reloaded.yjsState) ? reloaded.yjsState : Buffer.from((reloaded.yjsState as any).buffer);
      expect(asBuffer.equals(snapshot)).toBe(true);
      expect(reloaded.yjsCheckpointAt?.toISOString()).toBe('2026-05-14T00:00:00.000Z');
    });
  });

  describe('Normalize path', () => {
    describe('Normalize', () => {
      test('should start with slash', () => {
        expect(Page.normalizePath('hoge/fuga')).toBe('/hoge/fuga');
      });

      test('should trim spaces of slash', () => {
        expect(Page.normalizePath('/ hoge / fuga')).toBe('/hoge/fuga');
      });
    });
  });

  describe('.findPage', () => {
    describe('findPageById', () => {
      test('should find page', async () => {
        const pageToFind = createdPages[0];
        const page = await Page.findPageById(pageToFind._id);
        expect(page.path).toBe(pageToFind.path);
      });
    });

    describe('findPageByIdAndGrantedUser', () => {
      test('should find page', async () => {
        const pageToFind = createdPages[0];
        const grantedUser = createdUsers[0];
        const page = await Page.findPageByIdAndGrantedUser(pageToFind._id, grantedUser);
        expect(page.path).toBe(pageToFind.path);
      });

      test('should error by grant', async () => {
        const pageToFind = createdPages[0];
        const grantedUser = createdUsers[1];

        await expect(Page.findPageByIdAndGrantedUser(pageToFind._id, grantedUser)).rejects.toThrow('Page is not granted for the user');
      });
    });
  });

  describe('Rename Tree', () => {
    let user;

    const generatePages = (paths) => {
      const grant = Page.GRANT_PUBLIC;
      const grantedUsers = [user];
      const creator = user;
      const updatedAt = Date.now();
      return paths.map((path) => ({ path, grant, grantedUsers, creator, updatedAt }));
    };

    beforeAll(async () => {
      user = createdUsers[0];
      await Page.deleteMany({});
    });

    describe('A page already exists in the destination', () => {
      beforeEach(async () => {
        const paths = ['/jp/hoge', '/us/hoge/huga', '/jp/hoge/huga'];
        await Fixture.generate('Page', generatePages(paths));
      });

      describe('checkPagesRenamable', () => {
        test('should return error', async () => {
          const paths = await Page.findChildrenByPath('/jp/hoge', user, {});
          const pathMap = Page.getPathMap(paths, 'jp', 'us');
          const [error] = await Page.checkPagesRenamable(Object.values(pathMap), user);
          expect(error).toBe(true);
        });
      });

      afterEach(async () => Page.deleteMany({}));
    });

    describe('The number of pages is greater than 50', () => {
      let treeSize;
      beforeEach(async () => {
        await Page.deleteMany({});
        const children = Array.from(new Array(50).keys()).map((v) => `/parent/${v}`);
        const paths = ['/parent', ...children];
        treeSize = paths.length;
        await Fixture.generate('Page', generatePages(paths));
      });

      describe('findChildrenByPath', () => {
        test('should fetch a parent page and all children pages (more than 50 pages)', async () => {
          const pages = await Page.findChildrenByPath('/parent', user, {});
          expect(pages).toHaveLength(treeSize);
        });
      });

      afterEach(async () => Page.deleteMany({}));
    });

    describe('The name of the tree starts with the name of another tree', () => {
      beforeEach(async () => {
        await Page.deleteMany({});
        const paths = ['/car', '/car/ambulance', '/car/minicar', '/car/taxi', '/carrot'];
        await Fixture.generate('Page', generatePages(paths));
      });

      describe('findChildrenByPath', () => {
        test('should not contain other trees', async () => {
          const pages = await Page.findChildrenByPath('/car', user, {});
          expect(pages.length).toBe(4);
          expect(pages.some((page) => page.path === '/carrot')).toBe(false);
        });
      });

      afterEach(async () => Page.deleteMany({}));
    });

    describe('Last updated date and time of pages', () => {
      beforeEach(async () => {
        await Page.deleteMany({});
        const paths = ['/hoge', '/hoge/huga', '/hoge/piyo'];
        await Fixture.generate('Page', generatePages(paths));
      });

      describe('last updated date and time', () => {
        it('should not changed', async () => {
          const pages = await Page.findChildrenByPath('/hoge', user, {});

          const pathMap = Page.getPathMap(pages, '/hoge', '/huga');
          await Page.renameTree(pathMap, user, {});

          const renamedPages = await Page.findChildrenByPath('/huga', user, {});

          const selectUpdatedAt = (pages) => pages.map((page) => page.updatedAt);

          expect(selectUpdatedAt(pages)).toEqual(selectUpdatedAt(renamedPages));
        });
      });
    });

    // feature-rename-migration-refactor A4-1 — checkPagesRenamable batches its
    // per-path exists/findPageByPath lookups into chunked `$in` queries
    // (CHUNK_SIZE = 500). These focused tests exercise behaviour the existing
    // (few-path) fixtures above can't distinguish from a single unbounded `$in`.
    describe('checkPagesRenamable batching (A4-1)', () => {
      // Mirrors the pre-A4-1 per-path implementation exactly (per-path
      // `Page.exists` + `Page.findPageByPath` + `isUnlinkable`, in the same
      // push order as `checkPagesRenamable`). This is NOT production code —
      // it exists purely so the tests below can assert the batched `$in`
      // implementation returns byte-for-byte the same result (including key
      // order) as the old N+1 walk, across the CHUNK_SIZE=500 boundary.
      async function checkPagesRenamablePerPathReference(paths: string[], forUser) {
        let error = false;
        const errors: Record<string, string[]> = {};
        for (const path of paths) {
          const e: string[] = [];
          if (!Page.isCreatableName(path)) {
            e.push('rename_tree.error.can_not_use_this_name');
          }
          const isAlreadyExists = await Page.exists({ path });
          if (isAlreadyExists) {
            const newPage = await Page.findPageByPath(path);
            if (!newPage.isUnlinkable(forUser)) {
              e.push('rename_tree.error.already_exists');
            }
          }
          if (e.length > 0) {
            error = true;
          }
          errors[path] = e;
        }
        return [error, errors] as const;
      }

      beforeEach(async () => {
        await Page.deleteMany({});
      });

      afterEach(async () => Page.deleteMany({}));

      test('does not throw and validates every path when the count exceeds CHUNK_SIZE (500)', async () => {
        // None of these destination paths exist, so every entry should come
        // back error-free. This drives the walk across the 500-path chunk
        // boundary without needing per-path collision fixtures, so it stays
        // cheap while still covering "no throw + no drop/duplicate across
        // chunks".
        const paths = Array.from(new Array(501).keys()).map((i) => `/batch-check/${i}`);
        const [error, errors] = await Page.checkPagesRenamable(paths, user);
        expect(error).toBe(false);
        expect(Object.keys(errors)).toHaveLength(paths.length);
        for (const path of paths) {
          expect(errors[path]).toEqual([]);
        }
      });

      test('CHUNK_SIZE (500) boundary: collisions/invalid names on both sides match the per-path reference implementation', async () => {
        // 520 paths → chunk 1 = indices 0-499, chunk 2 = indices 500-519
        // (CHUNK_SIZE = 500). Seed a mix of an invalid name, an unlinkable
        // (redirect) collision, and a non-unlinkable collision at both the
        // start/end of chunk 1 and the start/end of chunk 2, so a bug that
        // drops/duplicates entries across the chunk boundary — or a batched
        // result that diverges from the old per-path semantics — would show
        // up as a mismatch against `checkPagesRenamablePerPathReference`.
        const TOTAL = 520;
        const paths = Array.from({ length: TOTAL }, (_, i) => `/batch-check2/${i}`);

        const invalidNameIdx = 3; // chunk 1 — pure isCreatableName rejection (unaffected by batching, included for full-path parity)
        const unlinkableChunk1Idx = 0; // chunk 1, first entry
        const collidingChunk1Idx = 499; // chunk 1, last entry — invalid name AND non-unlinkable collision together
        const unlinkableChunk2Idx = 500; // chunk 2, first entry
        const collidingChunk2Idx = 519; // chunk 2, last entry

        paths[invalidNameIdx] = '/batch-check2/invalid#name';
        paths[collidingChunk1Idx] = '/batch-check2/invalid$499';

        await Fixture.generate('Page', [
          // Unlinkable redirect collisions (chunk 1 first + chunk 2 first) —
          // must NOT be reported as `already_exists`.
          { path: paths[unlinkableChunk1Idx], grant: Page.GRANT_PUBLIC, redirectTo: '/somewhere-else', creator: user, grantedUsers: [user] },
          { path: paths[unlinkableChunk2Idx], grant: Page.GRANT_PUBLIC, redirectTo: '/somewhere-else', creator: user, grantedUsers: [user] },
          // Non-unlinkable collisions (chunk 1 last + chunk 2 last) — must be
          // reported as `already_exists`.
          { path: paths[collidingChunk1Idx], grant: Page.GRANT_PUBLIC, redirectTo: null, creator: user, grantedUsers: [user] },
          { path: paths[collidingChunk2Idx], grant: Page.GRANT_PUBLIC, redirectTo: null, creator: user, grantedUsers: [user] },
        ]);

        const [error, errors] = await Page.checkPagesRenamable(paths, user);
        const [refError, refErrors] = await checkPagesRenamablePerPathReference(paths, user);

        expect(error).toBe(true);
        expect(error).toBe(refError);
        // order-preserving parity: chunked-`$in` walk visits/reports paths in
        // the same order as the per-path reference walk.
        expect(Object.keys(errors)).toEqual(paths);
        expect(errors).toEqual(refErrors);

        // Explicit boundary-crossing spot checks (not just reference parity).
        expect(errors[paths[invalidNameIdx]]).toEqual(['rename_tree.error.can_not_use_this_name']);
        expect(errors[paths[unlinkableChunk1Idx]]).toEqual([]);
        expect(errors[paths[collidingChunk1Idx]]).toEqual(['rename_tree.error.can_not_use_this_name', 'rename_tree.error.already_exists']);
        expect(errors[paths[unlinkableChunk2Idx]]).toEqual([]);
        expect(errors[paths[collidingChunk2Idx]]).toEqual(['rename_tree.error.already_exists']);
      });

      test('preserves isUnlinkable semantics: an unlinkable redirect is not a collision, a non-unlinkable page is', async () => {
        await Fixture.generate('Page', [
          // Redirect origin (`redirectTo` set) + granted for `user` (public) →
          // isUnlinkable() === true → NOT reported as `already_exists`.
          {
            path: '/unlink-check/redirect-ok',
            grant: Page.GRANT_PUBLIC,
            redirectTo: '/somewhere-else',
            creator: user,
            grantedUsers: [user],
          },
          // Real page (no `redirectTo`) → isRedirectOriginPage() === false →
          // isUnlinkable() === false regardless of grant → `already_exists`.
          {
            path: '/unlink-check/real-page',
            grant: Page.GRANT_PUBLIC,
            redirectTo: null,
            creator: user,
            grantedUsers: [user],
          },
        ]);

        const [error, errors] = await Page.checkPagesRenamable(['/unlink-check/redirect-ok', '/unlink-check/real-page'], user);
        expect(error).toBe(true);
        expect(errors['/unlink-check/redirect-ok']).toEqual([]);
        expect(errors['/unlink-check/real-page']).toContain('rename_tree.error.already_exists');
      });

      test('isUnlinkable depends on creator/grantedUsers, not just grant — the projection must carry them', async () => {
        // GRANT_PUBLIC alone would make every case below `isGrantedFor() ===
        // true` regardless of `creator`/`grantedUsers` (see `isPublic()`),
        // so it can't tell apart a batch that dropped those fields from the
        // projection. Use GRANT_RESTRICTED throughout so `isGrantedFor` must
        // fall through to `isCreator`/`grantedUsers` — a projection missing
        // either field would flip these outcomes.
        const owner = user;
        const other = createdUsers[1];

        await Fixture.generate('Page', [
          // Restricted redirect, granted only via same `creator` (not in
          // `grantedUsers`) → isUnlinkable() === true → NOT `already_exists`.
          {
            path: '/unlink-check/restricted-by-creator',
            grant: Page.GRANT_RESTRICTED,
            redirectTo: '/somewhere-else',
            creator: owner,
            grantedUsers: [],
          },
          // Restricted redirect, granted only via `grantedUsers` (creator is
          // someone else) → isUnlinkable() === true → NOT `already_exists`.
          {
            path: '/unlink-check/restricted-by-granted-users',
            grant: Page.GRANT_RESTRICTED,
            redirectTo: '/somewhere-else',
            creator: other,
            grantedUsers: [owner],
          },
          // Restricted redirect, granted for neither (creator is someone
          // else, `owner` not in `grantedUsers`) → isGrantedFor() === false →
          // isUnlinkable() === false → `already_exists`, same as an ungranted
          // non-redirect page would be.
          {
            path: '/unlink-check/restricted-not-granted',
            grant: Page.GRANT_RESTRICTED,
            redirectTo: '/somewhere-else',
            creator: other,
            grantedUsers: [other],
          },
        ]);

        const [error, errors] = await Page.checkPagesRenamable(
          ['/unlink-check/restricted-by-creator', '/unlink-check/restricted-by-granted-users', '/unlink-check/restricted-not-granted'],
          owner,
        );

        expect(error).toBe(true);
        expect(errors['/unlink-check/restricted-by-creator']).toEqual([]);
        expect(errors['/unlink-check/restricted-by-granted-users']).toEqual([]);
        expect(errors['/unlink-check/restricted-not-granted']).toContain('rename_tree.error.already_exists');
      });
    });
  });

  // feature-child-segments-metadata: `lastUpdatedAt` / `updater` on each
  // `PageChildSegment` — additive contract fields derived within
  // `findChildSegments`'s existing scan (no extra per-segment query).
  describe('.findChildSegments (feature-child-segments-metadata)', () => {
    let author;
    let other;

    beforeAll(() => {
      author = createdUsers[0];
      other = createdUsers[1];
    });

    beforeEach(async () => {
      await Page.deleteMany({});
    });

    afterEach(async () => {
      await Page.deleteMany({});
    });

    test('isPage:true segment returns its own updatedAt/updater, even when a descendant is newer', async () => {
      const ownTime = new Date('2020-01-01T00:00:00Z');
      const descendantNewerTime = new Date('2024-01-01T00:00:00Z');
      await Fixture.generate('Page', [
        { path: '/tree/leaf', grant: Page.GRANT_PUBLIC, creator: author, status: 'published', updatedAt: ownTime, lastUpdateUser: author },
        {
          path: '/tree/leaf/child',
          grant: Page.GRANT_PUBLIC,
          creator: other,
          status: 'published',
          updatedAt: descendantNewerTime,
          lastUpdateUser: other,
        },
      ]);

      const segments = await Page.findChildSegments('/tree', author);
      const leaf = segments.find((s) => s.segment === 'leaf');
      expect(leaf?.isPage).toBe(true);
      expect(leaf?.lastUpdatedAt).toBe(ownTime.toISOString());
      expect(leaf?.updater?.username).toBe(author.username);
    });

    test('isPage:false segment returns the most-recently-updated descendant, not the (older) portal doc', async () => {
      const portalTime = new Date('2020-01-01T00:00:00Z');
      const olderChildTime = new Date('2021-01-01T00:00:00Z');
      const newestChildTime = new Date('2024-01-01T00:00:00Z');
      await Fixture.generate('Page', [
        { path: '/tree/portal/', grant: Page.GRANT_PUBLIC, creator: author, status: 'published', updatedAt: portalTime, lastUpdateUser: author },
        {
          path: '/tree/portal/child-a',
          grant: Page.GRANT_PUBLIC,
          creator: author,
          status: 'published',
          updatedAt: olderChildTime,
          lastUpdateUser: author,
        },
        {
          path: '/tree/portal/child-b',
          grant: Page.GRANT_PUBLIC,
          creator: other,
          status: 'published',
          updatedAt: newestChildTime,
          lastUpdateUser: other,
        },
      ]);

      const segments = await Page.findChildSegments('/tree', author);
      const portal = segments.find((s) => s.segment === 'portal');
      expect(portal?.isPage).toBe(false);
      expect(portal?.hasPortal).toBe(true);
      expect(portal?.count).toBe(2);
      expect(portal?.lastUpdatedAt).toBe(newestChildTime.toISOString());
      expect(portal?.updater?.username).toBe(other.username);
    });

    // openQuestions #1: hasPortal-only, zero descendants — `maxOtherMeta`
    // collapses to the portal doc's own metadata (fixed by this test).
    test('hasPortal-only segment with zero descendants uses the portal doc itself as representative', async () => {
      const portalTime = new Date('2022-06-01T00:00:00Z');
      await Fixture.generate('Page', [
        { path: '/tree/onlyportal/', grant: Page.GRANT_PUBLIC, creator: author, status: 'published', updatedAt: portalTime, lastUpdateUser: author },
      ]);

      const segments = await Page.findChildSegments('/tree', author);
      const seg = segments.find((s) => s.segment === 'onlyportal');
      expect(seg?.isPage).toBe(false);
      expect(seg?.hasPortal).toBe(true);
      expect(seg?.count).toBe(0);
      expect(seg?.lastUpdatedAt).toBe(portalTime.toISOString());
      expect(seg?.updater?.username).toBe(author.username);
    });

    test('existence concealment: a restricted descendant not granted to the viewer never wins representative-page selection, and is not counted', async () => {
      const visibleTime = new Date('2021-01-01T00:00:00Z');
      const hiddenNewerTime = new Date('2030-01-01T00:00:00Z');
      await Fixture.generate('Page', [
        { path: '/tree/secure/', grant: Page.GRANT_PUBLIC, creator: author, status: 'published', updatedAt: visibleTime, lastUpdateUser: author },
        {
          path: '/tree/secure/hidden',
          grant: Page.GRANT_RESTRICTED,
          grantedUsers: [other],
          creator: other,
          status: 'published',
          updatedAt: hiddenNewerTime,
          lastUpdateUser: other,
        },
      ]);

      // `author` is neither the creator nor in `grantedUsers` of the
      // restricted descendant, so it must be invisible to them.
      const segments = await Page.findChildSegments('/tree', author);
      const seg = segments.find((s) => s.segment === 'secure');
      expect(seg?.count).toBe(0); // the hidden descendant isn't even counted
      expect(seg?.lastUpdatedAt).toBe(visibleTime.toISOString());
      expect(seg?.updater?.username).toBe(author.username);
    });

    test("existence concealment: another user's newer draft descendant never wins representative-page selection", async () => {
      const publishedTime = new Date('2021-06-01T00:00:00Z');
      const draftNewerTime = new Date('2030-01-01T00:00:00Z');
      await Fixture.generate('Page', [
        { path: '/tree/mix/', grant: Page.GRANT_PUBLIC, creator: author, status: 'published', updatedAt: publishedTime, lastUpdateUser: author },
        {
          path: '/tree/mix/draft-by-other',
          grant: Page.GRANT_PUBLIC,
          creator: other,
          status: 'draft',
          updatedAt: draftNewerTime,
          lastUpdateUser: other,
        },
      ]);

      const segments = await Page.findChildSegments('/tree', author);
      const seg = segments.find((s) => s.segment === 'mix');
      expect(seg?.count).toBe(0);
      expect(seg?.lastUpdatedAt).toBe(publishedTime.toISOString());
      expect(seg?.updater?.username).toBe(author.username);
    });

    // Same concealment invariant as the test above, but for a PORTAL doc
    // (trailing-slash path) rather than a plain descendant page — the
    // reviewer flagged that the portal-shaped path wasn't covered
    // separately. Doubly non-visible to `author`: the draft-status clause
    // only admits `other`'s own drafts, AND the restricted grant only
    // admits `other` (creator) — either filter alone would already exclude
    // it. It must never win representative selection nor flip `hasPortal`,
    // even though its `updatedAt` is the newest in the subtree.
    test("existence concealment: another user's newer draft portal doc (trailing-slash path) never wins representative-page selection", async () => {
      const publishedChildTime = new Date('2021-06-01T00:00:00Z');
      const hiddenPortalNewerTime = new Date('2030-01-01T00:00:00Z');
      await Fixture.generate('Page', [
        {
          path: '/tree/hiddenportal/',
          grant: Page.GRANT_RESTRICTED,
          grantedUsers: [other],
          creator: other,
          status: 'draft',
          updatedAt: hiddenPortalNewerTime,
          lastUpdateUser: other,
        },
        {
          path: '/tree/hiddenportal/child',
          grant: Page.GRANT_PUBLIC,
          creator: author,
          status: 'published',
          updatedAt: publishedChildTime,
          lastUpdateUser: author,
        },
      ]);

      const segments = await Page.findChildSegments('/tree', author);
      const seg = segments.find((s) => s.segment === 'hiddenportal');
      expect(seg?.hasPortal).toBe(false); // the hidden draft portal doc never sets this
      expect(seg?.count).toBe(1); // only the visible child is counted
      expect(seg?.lastUpdatedAt).toBe(publishedChildTime.toISOString());
      expect(seg?.updater?.username).toBe(author.username);
    });

    // Not an existence-concealment case: unlike the two tests above (a
    // draft belonging to ANOTHER user, invisible to the viewer), the
    // viewer's OWN draft portal doc is legitimately visible to them (the
    // `visiblePageStatusOr` draft clause), so it is a valid `maxOtherMeta`
    // candidate — it can win representative selection when it is the
    // newest doc in the subtree, even though `status !== STATUS_DRAFT`
    // keeps `hasPortal` false (a draft portal is not yet "a real portal").
    test("viewer's own visible draft portal doc can win representative selection when it is the newest doc", async () => {
      const draftPortalNewestTime = new Date('2030-01-01T00:00:00Z');
      const childOlderTime = new Date('2021-01-01T00:00:00Z');
      await Fixture.generate('Page', [
        {
          path: '/tree/viewerdraft/',
          grant: Page.GRANT_PUBLIC,
          creator: author,
          status: 'draft',
          updatedAt: draftPortalNewestTime,
          lastUpdateUser: author,
        },
        {
          path: '/tree/viewerdraft/child',
          grant: Page.GRANT_PUBLIC,
          creator: author,
          status: 'published',
          updatedAt: childOlderTime,
          lastUpdateUser: author,
        },
      ]);

      const segments = await Page.findChildSegments('/tree', author);
      const seg = segments.find((s) => s.segment === 'viewerdraft');
      expect(seg?.isPage).toBe(false);
      expect(seg?.hasPortal).toBe(false); // a draft portal never sets hasPortal
      expect(seg?.count).toBe(1);
      expect(seg?.lastUpdatedAt).toBe(draftPortalNewestTime.toISOString());
      expect(seg?.updater?.username).toBe(author.username);
    });

    // Same setup, but the published descendant is newer than the viewer's
    // own draft portal doc — the descendant wins, confirming the draft
    // portal doc is just an ordinary `maxOtherMeta` candidate (not
    // special-cased to always win or always lose).
    test('a published descendant newer than the viewer own draft portal doc wins representative selection', async () => {
      const draftPortalOlderTime = new Date('2021-01-01T00:00:00Z');
      const childNewestTime = new Date('2030-01-01T00:00:00Z');
      await Fixture.generate('Page', [
        {
          path: '/tree/viewerdraft2/',
          grant: Page.GRANT_PUBLIC,
          creator: author,
          status: 'draft',
          updatedAt: draftPortalOlderTime,
          lastUpdateUser: author,
        },
        {
          path: '/tree/viewerdraft2/child',
          grant: Page.GRANT_PUBLIC,
          creator: other,
          status: 'published',
          updatedAt: childNewestTime,
          lastUpdateUser: other,
        },
      ]);

      const segments = await Page.findChildSegments('/tree', author);
      const seg = segments.find((s) => s.segment === 'viewerdraft2');
      expect(seg?.isPage).toBe(false);
      expect(seg?.hasPortal).toBe(false);
      expect(seg?.count).toBe(1);
      expect(seg?.lastUpdatedAt).toBe(childNewestTime.toISOString());
      expect(seg?.updater?.username).toBe(other.username);
    });

    test('updater is null (no throw) when lastUpdateUser references a hard-deleted user id', async () => {
      const ghostUserId = new Types.ObjectId();
      await Fixture.generate('Page', [
        {
          path: '/tree/orphan',
          grant: Page.GRANT_PUBLIC,
          creator: author,
          status: 'published',
          updatedAt: new Date('2023-01-01T00:00:00Z'),
          lastUpdateUser: ghostUserId,
        },
      ]);

      const segments = await Page.findChildSegments('/tree', author);
      const seg = segments.find((s) => s.segment === 'orphan');
      expect(seg?.isPage).toBe(true);
      expect(seg?.updater).toBeNull();
      expect(seg?.lastUpdatedAt).toBe('2023-01-01T00:00:00.000Z');
    });

    test('updater is null (no throw) when lastUpdateUser was never set (legacy row)', async () => {
      await Fixture.generate('Page', [
        { path: '/tree/legacy', grant: Page.GRANT_PUBLIC, creator: author, status: 'published', updatedAt: new Date('2019-01-01T00:00:00Z') },
      ]);

      const segments = await Page.findChildSegments('/tree', author);
      const seg = segments.find((s) => s.segment === 'legacy');
      expect(seg?.updater).toBeNull();
      expect(seg?.lastUpdatedAt).toBe('2019-01-01T00:00:00.000Z');
    });

    // openQuestions #3: `updatedAt` itself is absent (the `page` schema has
    // no `timestamps: true` and no default on this field — see the schema
    // definition — so a row saved without an explicit value truly has no
    // `updatedAt`, unlike the `lastUpdateUser`-only-missing case above).
    // `toISOStringOrNull` must fall back to `null` rather than throwing or
    // emitting `"Invalid Date"`.
    test('lastUpdatedAt is null (no throw) when the representative page has no updatedAt (legacy row predating the field)', async () => {
      await Fixture.generate('Page', [{ path: '/tree/notimestamp', grant: Page.GRANT_PUBLIC, creator: author, status: 'published', lastUpdateUser: author }]);

      const segments = await Page.findChildSegments('/tree', author);
      const seg = segments.find((s) => s.segment === 'notimestamp');
      expect(seg?.isPage).toBe(true);
      expect(seg?.lastUpdatedAt).toBeNull();
      expect(seg?.updater?.username).toBe(author.username);
    });

    test('does not add a per-row query: Page.find / User.find call counts stay flat as the tree grows (no N+1)', async () => {
      const pageFindSpy = jest.spyOn(Page, 'find');
      const userFindSpy = jest.spyOn(User, 'find');

      await Fixture.generate('Page', [
        {
          path: '/scale/small/a',
          grant: Page.GRANT_PUBLIC,
          creator: author,
          status: 'published',
          updatedAt: new Date(),
          lastUpdateUser: author,
        },
      ]);
      await Page.findChildSegments('/scale', author);
      const smallPageCalls = pageFindSpy.mock.calls.length;
      const smallUserCalls = userFindSpy.mock.calls.length;

      pageFindSpy.mockClear();
      userFindSpy.mockClear();
      await Page.deleteMany({});

      await Fixture.generate(
        'Page',
        Array.from({ length: 20 }, (_, i) => ({
          path: `/scale/big/child-${i}`,
          grant: Page.GRANT_PUBLIC,
          creator: author,
          status: 'published',
          updatedAt: new Date(),
          lastUpdateUser: i % 2 === 0 ? author : other,
        })),
      );
      await Page.findChildSegments('/scale', author);
      const bigPageCalls = pageFindSpy.mock.calls.length;
      const bigUserCalls = userFindSpy.mock.calls.length;

      pageFindSpy.mockRestore();
      userFindSpy.mockRestore();

      // Exactly one `Page.find` (the existing scan) + one batched
      // `User.find` (the added `lastUpdateUser` batch lookup), regardless
      // of how many pages/segments were scanned.
      expect(smallPageCalls).toBe(1);
      expect(smallUserCalls).toBe(1);
      expect(bigPageCalls).toBe(smallPageCalls);
      expect(bigUserCalls).toBe(smallUserCalls);
    });
  });

  // RFC-0004 Phase 2: draft page status + draft visibility filtering.
  describe('Draft pages (RFC-0004)', () => {
    let author;
    let other;

    beforeAll(async () => {
      author = createdUsers[0];
      other = createdUsers[1];
    });

    beforeEach(async () => {
      await Page.deleteMany({});
    });

    afterEach(async () => {
      await Page.deleteMany({});
    });

    describe('.isDraft', () => {
      test('returns true only for a draft page', async () => {
        const [draft, published] = await Fixture.generate('Page', [
          { path: '/drafts/a', grant: Page.GRANT_PUBLIC, creator: author, status: 'draft' },
          { path: '/drafts/b', grant: Page.GRANT_PUBLIC, creator: author, status: 'published' },
        ]);
        expect(draft.isDraft()).toBe(true);
        expect(draft.isPublished()).toBe(false);
        expect(published.isDraft()).toBe(false);
        expect(published.isPublished()).toBe(true);
      });
    });

    describe('findListByStartWith', () => {
      beforeEach(async () => {
        await Fixture.generate('Page', [
          { path: '/team/published', grant: Page.GRANT_PUBLIC, creator: author, status: 'published' },
          { path: '/team/author-draft', grant: Page.GRANT_PUBLIC, creator: author, status: 'draft' },
          { path: '/team/other-draft', grant: Page.GRANT_PUBLIC, creator: other, status: 'draft' },
        ]);
      });

      test("excludes another user's draft from the listing", async () => {
        const pages = await Page.findListByStartWith('/team', other, {});
        const paths = pages.map((p) => p.path);
        expect(paths).toContain('/team/published');
        expect(paths).toContain('/team/other-draft'); // viewer's own draft
        expect(paths).not.toContain('/team/author-draft'); // someone else's draft
      });

      test("includes the viewer's own draft in the listing", async () => {
        const pages = await Page.findListByStartWith('/team', author, {});
        const paths = pages.map((p) => p.path);
        expect(paths).toContain('/team/published');
        expect(paths).toContain('/team/author-draft');
        expect(paths).not.toContain('/team/other-draft');
      });
    });

    describe('findListByCreator', () => {
      beforeEach(async () => {
        await Fixture.generate('Page', [
          { path: '/by/published', grant: Page.GRANT_PUBLIC, creator: author, status: 'published' },
          { path: '/by/draft', grant: Page.GRANT_PUBLIC, creator: author, status: 'draft' },
        ]);
      });

      test('includes own drafts when the creator views their own pages', async () => {
        const pages = await Page.findListByCreator(author, {}, author);
        const paths = pages.map((p) => p.path);
        expect(paths).toContain('/by/published');
        expect(paths).toContain('/by/draft');
      });

      test("excludes drafts when another user views the creator's pages", async () => {
        const pages = await Page.findListByCreator(author, {}, other);
        const paths = pages.map((p) => p.path);
        expect(paths).toContain('/by/published');
        expect(paths).not.toContain('/by/draft');
      });
    });
  });

  describe('findSubpagesByUserNamespace (feature-user-page-subpages-tab)', () => {
    let author;
    let other;

    beforeAll(() => {
      author = createdUsers[0];
      other = createdUsers[1];
    });

    beforeEach(async () => {
      await Page.deleteMany({});
    });

    afterEach(async () => {
      await Page.deleteMany({});
    });

    test('recurses into all depths under the namespace, sorted path-ascending', async () => {
      await Fixture.generate('Page', [
        { path: '/user/alice/notes', grant: Page.GRANT_PUBLIC, creator: author, status: 'published' },
        { path: '/user/alice/project/deep/nested', grant: Page.GRANT_PUBLIC, creator: author, status: 'published' },
        { path: '/user/alice2/other', grant: Page.GRANT_PUBLIC, creator: author, status: 'published' },
      ]);

      const { rawPages, total } = await Page.findSubpagesByUserNamespace('/user/alice/', author._id, { limit: 50, offset: 0 });
      const paths = rawPages.map((p) => p.path);
      // Sorted path-ascending; the other namespace (`/user/alice2/...`) and the
      // intermediate `/user/alice/project` (which doesn't exist as its own
      // document) never appear.
      expect(paths).toEqual(['/user/alice/notes', '/user/alice/project/deep/nested']);
      expect(total).toBe(2);
    });

    test('excludes the home page (no trailing slash) and the trailing-slash self-twin', async () => {
      await Fixture.generate('Page', [
        // `/user/alice` (no slash) never matches the `^/user/alice/` regex —
        // included here to document that fact, not because it's the risk.
        { path: '/user/alice', grant: Page.GRANT_PUBLIC, creator: author, status: 'published' },
        // `/user/alice/` IS matched by the prefix regex (a string is a
        // prefix of itself) and is a real, separate document from the home
        // page — the `$ne: prefix` exclusion is the thing under test.
        { path: '/user/alice/', grant: Page.GRANT_PUBLIC, creator: author, status: 'published' },
        { path: '/user/alice/notes', grant: Page.GRANT_PUBLIC, creator: author, status: 'published' },
      ]);

      const { rawPages, total } = await Page.findSubpagesByUserNamespace('/user/alice/', author._id, { limit: 50, offset: 0 });
      const paths = rawPages.map((p) => p.path);
      expect(paths).toEqual(['/user/alice/notes']);
      expect(paths).not.toContain('/user/alice');
      expect(paths).not.toContain('/user/alice/');
      expect(total).toBe(1);
    });

    test('excludes redirect pages and soft-deleted pages', async () => {
      await Fixture.generate('Page', [
        { path: '/user/alice/redirected', grant: Page.GRANT_PUBLIC, creator: author, status: 'published', redirectTo: '/user/alice/target' },
        { path: '/user/alice/removed', grant: Page.GRANT_PUBLIC, creator: author, status: 'deleted' },
        { path: '/user/alice/visible', grant: Page.GRANT_PUBLIC, creator: author, status: 'published' },
      ]);

      const { rawPages, total } = await Page.findSubpagesByUserNamespace('/user/alice/', author._id, { limit: 50, offset: 0 });
      expect(rawPages.map((p) => p.path)).toEqual(['/user/alice/visible']);
      expect(total).toBe(1);
    });

    test('excludes wip/deprecated pages even when grant is public (visiblePageStatusOr has no clause for them)', async () => {
      await Fixture.generate('Page', [
        { path: '/user/alice/wip-page', grant: Page.GRANT_PUBLIC, creator: author, status: 'wip' },
        { path: '/user/alice/deprecated-page', grant: Page.GRANT_PUBLIC, creator: author, status: 'deprecated' },
        { path: '/user/alice/ok', grant: Page.GRANT_PUBLIC, creator: author, status: 'published' },
      ]);

      const { rawPages, total } = await Page.findSubpagesByUserNamespace('/user/alice/', other._id, { limit: 50, offset: 0 });
      expect(rawPages.map((p) => p.path)).toEqual(['/user/alice/ok']);
      expect(total).toBe(1);
    });

    test('a draft page is visible only to its creator', async () => {
      await Fixture.generate('Page', [{ path: '/user/alice/draft-page', grant: Page.GRANT_PUBLIC, creator: author, status: 'draft' }]);

      const asAuthor = await Page.findSubpagesByUserNamespace('/user/alice/', author._id, { limit: 50, offset: 0 });
      expect(asAuthor.rawPages.map((p) => p.path)).toEqual(['/user/alice/draft-page']);
      expect(asAuthor.total).toBe(1);

      const asOther = await Page.findSubpagesByUserNamespace('/user/alice/', other._id, { limit: 50, offset: 0 });
      expect(asOther.rawPages).toEqual([]);
      expect(asOther.total).toBe(0);
    });

    test('a restricted-grant page is visible only to grantedUsers/creator', async () => {
      await Fixture.generate('Page', [
        { path: '/user/alice/restricted', grant: Page.GRANT_RESTRICTED, grantedUsers: [author], creator: author, status: 'published' },
      ]);

      const asOther = await Page.findSubpagesByUserNamespace('/user/alice/', other._id, { limit: 50, offset: 0 });
      expect(asOther.total).toBe(0);

      const asAuthor = await Page.findSubpagesByUserNamespace('/user/alice/', author._id, { limit: 50, offset: 0 });
      expect(asAuthor.total).toBe(1);
    });

    test('total reflects only the viewer-authorized rows, never leaking hidden pages', async () => {
      await Fixture.generate('Page', [
        { path: '/user/alice/public-a', grant: Page.GRANT_PUBLIC, creator: author, status: 'published' },
        { path: '/user/alice/public-b', grant: Page.GRANT_PUBLIC, creator: author, status: 'published' },
        { path: '/user/alice/restricted-hidden', grant: Page.GRANT_RESTRICTED, grantedUsers: [author], creator: author, status: 'published' },
        { path: '/user/alice/other-draft-hidden', grant: Page.GRANT_PUBLIC, creator: author, status: 'draft' },
      ]);

      const { rawPages, total } = await Page.findSubpagesByUserNamespace('/user/alice/', other._id, { limit: 50, offset: 0 });
      expect(total).toBe(2);
      expect(rawPages).toHaveLength(2);
    });

    test('paginates via limit/offset without duplicates or gaps when nothing else writes concurrently', async () => {
      await Fixture.generate(
        'Page',
        Array.from({ length: 5 }, (_, i) => ({ path: `/user/alice/page-${i}`, grant: Page.GRANT_PUBLIC, creator: author, status: 'published' })),
      );

      const page1 = await Page.findSubpagesByUserNamespace('/user/alice/', author._id, { limit: 2, offset: 0 });
      const page2 = await Page.findSubpagesByUserNamespace('/user/alice/', author._id, { limit: 2, offset: 2 });
      const page3 = await Page.findSubpagesByUserNamespace('/user/alice/', author._id, { limit: 2, offset: 4 });

      const allPaths = [...page1.rawPages, ...page2.rawPages, ...page3.rawPages].map((p) => p.path);
      expect(allPaths).toEqual(['/user/alice/page-0', '/user/alice/page-1', '/user/alice/page-2', '/user/alice/page-3', '/user/alice/page-4']);
      expect(page1.total).toBe(5);
      expect(page2.total).toBe(5);
    });
  });

  describe('.updatePage — grant preservation (regression)', () => {
    let Revision;
    let actor;

    beforeAll(() => {
      Revision = crowi.model('Revision');
      actor = createdUsers[0];
    });

    afterEach(async () => {
      await Page.deleteMany({ path: { $regex: '^/regression/grant' } });
      await Revision.deleteMany({ path: { $regex: '^/regression/grant' } });
    });

    test('a body-only update (no grant option) keeps the page grant untouched', async () => {
      const created = await Page.createPage('/regression/grant-preserve', 'before', actor, {});
      expect(created.grant).toBe(Page.GRANT_PUBLIC);

      // The bug: `options.grant || null` made this null the grant. With the fix
      // a grant-less update defaults to the current grant and leaves it as-is.
      await Page.updatePage(created, 'after', actor, {});

      const reloaded = await Page.findById(created._id).select('grant').lean();
      expect(reloaded?.grant).toBe(Page.GRANT_PUBLIC);
    });

    test('an explicit grant change is still applied', async () => {
      const created = await Page.createPage('/regression/grant-change', 'before', actor, {});
      await Page.updatePage(created, 'after', actor, { grant: Page.GRANT_RESTRICTED });

      const reloaded = await Page.findById(created._id).select('grant').lean();
      expect(reloaded?.grant).toBe(Page.GRANT_RESTRICTED);
    });
  });

  describe('findListByPageIds — grant refilter (SEC-SEARCH-DELEGATED)', () => {
    let owner;
    let other;
    let publicPage;
    let legacyPublicPage;
    let ownerGrantedPage;
    let missingId;

    beforeAll(() => {
      owner = createdUsers[0];
      other = createdUsers[1];
    });

    beforeEach(async () => {
      await Page.deleteMany({ path: { $regex: '^/refilter' } });
      [publicPage, legacyPublicPage, ownerGrantedPage] = await Fixture.generate('Page', [
        { path: '/refilter/public', grant: Page.GRANT_PUBLIC, creator: owner, grantedUsers: [owner] },
        // Pre-grant-field pages stored `grant: null`; visiblePageGrantOr treats
        // that the same as public (see its `{ grant: null }` clause).
        { path: '/refilter/legacy-public', grant: null, creator: owner, grantedUsers: [owner] },
        { path: '/refilter/owner-only', grant: Page.GRANT_OWNER, creator: owner, grantedUsers: [owner] },
      ]);
      // 24-hex id with no backing Page doc, mirroring search.ts's
      // "populate couldn't find the doc" (e.g. concurrently deleted) case.
      missingId = '0123456789abcdef01234567';
    });

    afterEach(async () => {
      await Page.deleteMany({ path: { $regex: '^/refilter' } });
    });

    test('without a viewerId, returns every id regardless of grant (back-compat, no filter applied)', async () => {
      const ids = [publicPage._id, ownerGrantedPage._id];
      const pages = await Page.findListByPageIds(ids, { limit: ids.length });
      const paths = pages.map((p) => p.path);
      expect(paths).toContain('/refilter/public');
      expect(paths).toContain('/refilter/owner-only');
    });

    test('with a viewerId who is not in grantedUsers, drops the owner-only page but keeps the public one', async () => {
      const ids = [publicPage._id, ownerGrantedPage._id];
      const pages = await Page.findListByPageIds(ids, { limit: ids.length }, other._id);
      const paths = pages.map((p) => p.path);
      expect(paths).toContain('/refilter/public');
      expect(paths).not.toContain('/refilter/owner-only');
    });

    test('with a viewerId not in grantedUsers, keeps a legacy grant:null page (treated as public)', async () => {
      const ids = [legacyPublicPage._id, ownerGrantedPage._id];
      const pages = await Page.findListByPageIds(ids, { limit: ids.length }, other._id);
      const paths = pages.map((p) => p.path);
      expect(paths).toContain('/refilter/legacy-public');
      expect(paths).not.toContain('/refilter/owner-only');
    });

    test('with a viewerId who is in grantedUsers, keeps the owner-only page', async () => {
      const ids = [publicPage._id, ownerGrantedPage._id];
      const pages = await Page.findListByPageIds(ids, { limit: ids.length }, owner._id);
      const paths = pages.map((p) => p.path);
      expect(paths).toContain('/refilter/public');
      expect(paths).toContain('/refilter/owner-only');
    });

    test('grant refiltering and missing-doc dropping compose: only the visible+existing id survives', async () => {
      const ids = [publicPage._id, ownerGrantedPage._id, missingId];
      const pages = await Page.findListByPageIds(ids, { limit: ids.length }, other._id);
      const paths = pages.map((p) => p.path);
      expect(pages).toHaveLength(1);
      expect(paths).toEqual(['/refilter/public']);
    });
  });

  // `visiblePageGrantOr` (query-time) and `isGrantedFor` (in-memory) must be
  // derived from the same rule table, including the creator clause. A
  // non-creator (e.g. an admin) changing a page's grant must not reset
  // `grantedUsers` to just themselves, which would silently drop the page
  // from the creator's own listings even though `isGrantedFor`/`isCreator`
  // still lets the creator open it by id.
  describe('Grant predicate parity — creator stays visible after a non-creator grant change', () => {
    let creator;
    let admin;
    let stranger;

    beforeAll(async () => {
      const users = await Fixture.generate('User', [
        { name: 'Grant Parity Creator', username: 'grantParityCreator', email: 'grant-parity-creator@example.com' },
        { name: 'Grant Parity Admin', username: 'grantParityAdmin', email: 'grant-parity-admin@example.com' },
        { name: 'Grant Parity Stranger', username: 'grantParityStranger', email: 'grant-parity-stranger@example.com' },
      ]);
      [creator, admin, stranger] = users;
    });

    afterEach(async () => {
      await Page.deleteMany({ path: { $regex: '^/grant-parity' } });
    });

    // admin is not the creator, and grant changes previously reset
    // grantedUsers to just the actor performing the change.
    async function createPageThenRestrictedByAdmin(path: string) {
      const page = await Page.createPage(path, 'body', creator, {});
      await Page.updateGrant(page, Page.GRANT_SPECIFIED, admin);
      return page;
    }

    test("creator's page still appears in findListByStartWith after a non-creator (admin) restricts the grant", async () => {
      await createPageThenRestrictedByAdmin('/grant-parity/team-doc');

      const pages = await Page.findListByStartWith('/grant-parity', creator, {});
      const paths = pages.map((p) => p.path);
      expect(paths).toContain('/grant-parity/team-doc');
    });

    test('isGrantedFor(creator) and a visiblePageGrantOr(creator) query never disagree (creator + stranger)', async () => {
      const page = await createPageThenRestrictedByAdmin('/grant-parity/parity-doc');

      const reloaded = await Page.findById(page._id);
      expect(reloaded.isGrantedFor(creator)).toBe(true);
      expect(reloaded.isGrantedFor(stranger)).toBe(false);

      const foundForCreator = await Page.findOne({ _id: page._id, $or: visiblePageGrantOr(creator._id) });
      expect(foundForCreator).not.toBeNull();

      const foundForStranger = await Page.findOne({ _id: page._id, $or: visiblePageGrantOr(stranger._id) });
      expect(foundForStranger).toBeNull();
    });

    test('updateGrant keeps the creator in grantedUsers even when a different user changes the grant', async () => {
      const page = await createPageThenRestrictedByAdmin('/grant-parity/keep-creator');

      const reloaded = await Page.findById(page._id).select('grantedUsers').lean();
      const grantedIds = (reloaded?.grantedUsers ?? []).map((id) => id.toString());
      expect(grantedIds).toContain(admin._id.toString());
      expect(grantedIds).toContain(creator._id.toString());
    });
  });

  // feature-restricted-grant-share-banner Phase 1 — grant-on-first-access
  // (invite-link) resolution. This static is a pure ACL read/mutation (no
  // search reindex / page event side effects — those are the handler's
  // job, verified separately in hono/handlers/page.test.ts).
  describe('.findPageByIdForSharedLinkAccess (feature-restricted-grant-share-banner Phase 1)', () => {
    let linkCreator;
    let claimant;

    beforeAll(async () => {
      const users = await Fixture.generate('User', [
        { name: 'Link Access Model Creator', username: 'linkAccessModelCreator', email: 'link-access-model-creator@example.com' },
        { name: 'Link Access Model Claimant', username: 'linkAccessModelClaimant', email: 'link-access-model-claimant@example.com' },
      ]);
      [linkCreator, claimant] = users;
    });

    afterEach(async () => {
      await Page.deleteMany({ path: { $regex: '^/link-access-model' } });
    });

    const grantedUsersOf = async (id) => {
      const reloaded = await Page.findById(id).select('grantedUsers').lean();
      return (reloaded?.grantedUsers ?? []).map((v) => v.toString());
    };

    test('grants first-time access to a GRANT_RESTRICTED page: granted === true, and the caller lands in grantedUsers', async () => {
      const [page] = await Fixture.generate('Page', [
        { path: '/link-access-model/first-grant', grant: Page.GRANT_RESTRICTED, creator: linkCreator, grantedUsers: [linkCreator] },
      ]);

      const result = await Page.findPageByIdForSharedLinkAccess(page._id, claimant);
      expect(result.granted).toBe(true);
      expect(result.page.isGrantedFor(claimant)).toBe(true);
      expect(await grantedUsersOf(page._id)).toContain(claimant._id.toString());
    });

    test('a second claim by the same user is a pass-through: granted === false, no duplicate grantedUsers entry', async () => {
      const [page] = await Fixture.generate('Page', [
        { path: '/link-access-model/second-claim', grant: Page.GRANT_RESTRICTED, creator: linkCreator, grantedUsers: [linkCreator] },
      ]);

      const first = await Page.findPageByIdForSharedLinkAccess(page._id, claimant);
      expect(first.granted).toBe(true);

      const second = await Page.findPageByIdForSharedLinkAccess(page._id, claimant);
      expect(second.granted).toBe(false);

      const ids = await grantedUsersOf(page._id);
      expect(ids.filter((id) => id === claimant._id.toString())).toHaveLength(1);
    });

    test.each([
      ['GRANT_PUBLIC', () => Page.GRANT_PUBLIC],
      ['GRANT_SPECIFIED', () => Page.GRANT_SPECIFIED],
      ['GRANT_OWNER', () => Page.GRANT_OWNER],
    ])('%s pages do not trigger grant-on-access (pass-through for public, 403 for the rest)', async (label, grantFn) => {
      const [page] = await Fixture.generate('Page', [
        { path: `/link-access-model/non-restricted-${label}`, grant: grantFn(), creator: linkCreator, grantedUsers: [linkCreator] },
      ]);

      if (label === 'GRANT_PUBLIC') {
        const result = await Page.findPageByIdForSharedLinkAccess(page._id, claimant);
        expect(result.granted).toBe(false);
      } else {
        await expect(Page.findPageByIdForSharedLinkAccess(page._id, claimant)).rejects.toThrow('Page is not granted for the user');
      }
      expect(await grantedUsersOf(page._id)).not.toContain(claimant._id.toString());
    });

    test('the creator opening their own GRANT_RESTRICTED page is a pass-through (granted === false, no write)', async () => {
      const [page] = await Fixture.generate('Page', [
        { path: '/link-access-model/creator-passthrough', grant: Page.GRANT_RESTRICTED, creator: linkCreator, grantedUsers: [linkCreator] },
      ]);

      const result = await Page.findPageByIdForSharedLinkAccess(page._id, linkCreator);
      expect(result.granted).toBe(false);
    });

    test('does not invite into a deleted GRANT_RESTRICTED page (throws, no write)', async () => {
      const [page] = await Fixture.generate('Page', [
        {
          path: '/link-access-model/deleted',
          grant: Page.GRANT_RESTRICTED,
          creator: linkCreator,
          grantedUsers: [linkCreator],
          status: STATUS_DELETED,
        },
      ]);

      await expect(Page.findPageByIdForSharedLinkAccess(page._id, claimant)).rejects.toThrow('Page is not granted for the user');
      expect(await grantedUsersOf(page._id)).not.toContain(claimant._id.toString());
    });

    test('a redirect stub (GRANT_PUBLIC, redirectTo set — the real shape Page.rename creates) is a pass-through, not an invite target', async () => {
      const [stub] = await Fixture.generate('Page', [
        {
          path: '/link-access-model/stub-source',
          grant: Page.GRANT_PUBLIC,
          creator: linkCreator,
          grantedUsers: [],
          redirectTo: '/link-access-model/stub-target',
        },
      ]);

      const result = await Page.findPageByIdForSharedLinkAccess(stub._id, claimant);
      expect(result.granted).toBe(false);
    });

    test('grant-on-first-access still succeeds after a normal rename (same real _id, redirectTo stays null) — the shared link survives the rename', async () => {
      const [page] = await Fixture.generate('Page', [
        { path: '/link-access-model/rename-source', grant: Page.GRANT_RESTRICTED, creator: linkCreator, grantedUsers: [linkCreator] },
      ]);

      await Page.rename(page, '/link-access-model/rename-dest', linkCreator, {});

      const result = await Page.findPageByIdForSharedLinkAccess(page._id, claimant);
      expect(result.granted).toBe(true);
    });

    test('legacy pages with a missing (not explicit null) redirectTo field are still eligible for grant-on-access', async () => {
      const [page] = await Fixture.generate('Page', [
        {
          path: '/link-access-model/legacy-missing-redirect-to',
          grant: Page.GRANT_RESTRICTED,
          creator: linkCreator,
          grantedUsers: [linkCreator],
          // redirectTo intentionally omitted — legacy shape (field missing,
          // not explicitly null).
        },
      ]);
      const stored = await Page.findById(page._id).select('redirectTo').lean();
      expect(stored?.redirectTo).toBeUndefined();

      const result = await Page.findPageByIdForSharedLinkAccess(page._id, claimant);
      expect(result.granted).toBe(true);
    });

    test('TOCTOU: a concurrent grant change landing between read and write leaves the write unmatched — fresh reread falls to 403', async () => {
      const [page] = await Fixture.generate('Page', [
        { path: '/link-access-model/toctou-grant-change', grant: Page.GRANT_RESTRICTED, creator: linkCreator, grantedUsers: [linkCreator] },
      ]);

      const realFindPageById = Page.findPageById.bind(Page);
      const spy = jest.spyOn(Page, 'findPageById').mockImplementationOnce(async (id) => {
        const pageData = await realFindPageById(id);
        // Simulate a `PUT /pages/grant` landing between our read and our
        // atomic write — by the time the atomic findOneAndUpdate runs,
        // grant is no longer GRANT_RESTRICTED.
        await Page.updateGrant(pageData, Page.GRANT_OWNER, linkCreator);
        return pageData; // stale snapshot: still shows GRANT_RESTRICTED
      });

      try {
        await expect(Page.findPageByIdForSharedLinkAccess(page._id, claimant)).rejects.toThrow('Page is not granted for the user');
      } finally {
        spy.mockRestore();
      }

      const reloaded = await Page.findById(page._id).select('grant grantedUsers').lean();
      expect(reloaded?.grant).toBe(Page.GRANT_OWNER);
      expect((reloaded?.grantedUsers ?? []).map((id) => id.toString())).not.toContain(claimant._id.toString());
    });

    test('TOCTOU: a concurrent soft-delete landing between read and write leaves the write unmatched — fresh reread falls to 403', async () => {
      const [page] = await Fixture.generate('Page', [
        { path: '/link-access-model/toctou-delete', grant: Page.GRANT_RESTRICTED, creator: linkCreator, grantedUsers: [linkCreator] },
      ]);

      const realFindPageById = Page.findPageById.bind(Page);
      const spy = jest.spyOn(Page, 'findPageById').mockImplementationOnce(async (id) => {
        const pageData = await realFindPageById(id);
        // Simulate a soft-delete landing between our read and our atomic
        // write — by the time findOneAndUpdate runs, status is no longer
        // published.
        await Page.updatePageProperty(pageData, { status: STATUS_DELETED });
        return pageData; // stale snapshot: still shows status published
      });

      try {
        await expect(Page.findPageByIdForSharedLinkAccess(page._id, claimant)).rejects.toThrow('Page is not granted for the user');
      } finally {
        spy.mockRestore();
      }

      const reloaded = await Page.findById(page._id).select('status grantedUsers').lean();
      expect(reloaded?.status).toBe(STATUS_DELETED);
      expect((reloaded?.grantedUsers ?? []).map((id) => id.toString())).not.toContain(claimant._id.toString());
    });

    test('a soft-delete landing AFTER the atomic write already committed does not roll back the invite', async () => {
      const [page] = await Fixture.generate('Page', [
        { path: '/link-access-model/delete-after-commit', grant: Page.GRANT_RESTRICTED, creator: linkCreator, grantedUsers: [linkCreator] },
      ]);

      // The write commits normally (no interleaving this time) ...
      const result = await Page.findPageByIdForSharedLinkAccess(page._id, claimant);
      expect(result.granted).toBe(true);
      expect(result.page.isGrantedFor(claimant)).toBe(true);

      // ... and only THEN does the page get soft-deleted (the moral
      // equivalent of "deleted one second after the invite link was
      // clicked"). This must not roll back the just-committed grant — the
      // invite is understood the same as if it had happened moments before
      // the delete (spec's security注記 point 6).
      await Page.updatePageProperty(page, { status: STATUS_DELETED });

      const reloaded = await Page.findById(page._id).select('status grantedUsers').lean();
      expect(reloaded?.status).toBe(STATUS_DELETED);
      expect((reloaded?.grantedUsers ?? []).map((id) => id.toString())).toContain(claimant._id.toString());
    });
  });

  describe('Revision.page (feature-revision-page-ref, DC-5)', () => {
    let Revision;
    let user;

    beforeAll(() => {
      Revision = crowi.model('Revision');
      user = createdUsers[0];
    });

    test('prepareRevision (via Page.createPage / updatePage) stamps the immutable page id on every new revision', async () => {
      const path = '/revision-page-ref/prepare-revision';
      const created = await Page.createPage(path, 'v1', user, {});
      expect(created.revision.page?.toString()).toBe(created._id.toString());

      const updated = await Page.updatePage(created, 'v2', user, {});
      expect(updated.revision.page?.toString()).toBe(created._id.toString());

      const allRevisions = await Revision.find({ page: created._id }).lean();
      expect(allRevisions).toHaveLength(2);
    });

    test('Page.removePage deletes revisions via the immutable page id, robust against path reuse', async () => {
      const path = '/revision-page-ref/removepage-reuse';
      const pageA = await Page.createPage(path, 'body A', user, {});
      const pageAId = pageA._id;

      await Page.removePage(pageA);
      expect(await Page.findById(pageAId).exec()).toBeNull();
      expect(await Revision.countDocuments({ page: pageAId })).toBe(0);

      // A different page created afterwards at the SAME (now-freed) path
      // is completely unaffected — `removeRevisionsByPageId` never touched
      // it because it never shared A's page id, unlike the old path-keyed
      // `removeRevisionsByPath` which would have matched by string alone.
      const pageB = await Page.createPage(path, 'body B', user, {});
      const revisionsForB = await Revision.find({ page: pageB._id }).lean();
      expect(revisionsForB).toHaveLength(1);
      expect(revisionsForB[0].body).toBe('body B');
    });
  });

  describe('History tracking (RFC-0021 Phase 1 + Phase 2a)', () => {
    let user;
    let Revision;

    beforeAll(() => {
      user = createdUsers[0];
      Revision = crowi.model('Revision');
    });

    // Builds a Page directly via `Page.create` (bypassing `pushRevision`/the
    // allocator), i.e. the shape of a Phase-1-era Page that has never been
    // saved through Phase 2a — used by the fixtures below that need to start
    // from `untracked`.
    async function createUntrackedPage(path: string) {
      return Page.create({
        path,
        creator: user._id,
        lastUpdateUser: user._id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        redirectTo: null,
        grant: Page.GRANT_PUBLIC,
        status: 'published',
        grantedUsers: [user._id],
      });
    }

    /**
     * Phase 2a wires `allocateContentSequence` into `Page.pushRevision`
     * (called from both `Page.createPage` and `Page.updatePage`) AFTER the
     * pointer write commits (spec §D-1) — a SEPARATE write against the
     * database, not a mutation of the in-memory Page/Revision objects
     * `pushRevision` returns (`pageData`'s in-memory `historyTracking`/
     * `historySequence` are never touched by the allocator call). Every
     * assertion below therefore re-fetches from the database instead of
     * trusting the object `createPage`/`updatePage` resolved with.
     */
    describe('content-sequence allocation on write (AC-1, AC-3, AC-6, AC-20)', () => {
      test('AC-1: a newly created Page becomes ready with historySequence 1, and its initial Revision is sequence 1', async () => {
        const created = await Page.createPage('/history-tracking/new-page', 'v1', user, {});

        const reloadedPage = await Page.findById(created._id);
        expect(reloadedPage.historyTracking.state).toBe('ready');
        expect(reloadedPage.historySequence).toBe(1);
        expect(reloadedPage.pendingHistoryEntry).toBeUndefined();

        const revision = await Revision.findById(created.revision);
        expect(revision).not.toBeNull();
        expect(revision?.historySequence).toBe(1);
      });

      test('AC-3: a second HTTP save on an already-ready Page assigns the next sequence', async () => {
        const created = await Page.createPage('/history-tracking/ready-next-sequence', 'v1', user, {});

        const updated = await Page.updatePage(created, 'v2', user, {});

        const reloadedPage = await Page.findById(created._id);
        expect(reloadedPage.historyTracking.state).toBe('ready');
        expect(reloadedPage.historySequence).toBe(2);

        const newRevision = await Revision.findById(updated.revision);
        expect(newRevision?.historySequence).toBe(2);
      });

      test('AC-6: an existing untracked Page with pre-existing Revisions is promoted to ready by its next HTTP save, in one write, without touching the old Revisions', async () => {
        // 2 pre-existing Revisions on top of the untracked fixture —
        // simulating a Phase-1-era Page that predates Phase 2a and has
        // never been saved through it.
        const page = await createUntrackedPage('/history-tracking/promote-existing');
        const oldRevision1 = await Revision.create({ page: page._id, path: page.path, body: 'old-1', format: 'markdown', author: user._id });
        const oldRevision2 = await Revision.create({ page: page._id, path: page.path, body: 'old-2', format: 'markdown', author: user._id });
        await Page.updateOne({ _id: page._id }, { $set: { revision: oldRevision2._id } });
        const pageBeforeUpdate = await Page.findById(page._id);
        expect(pageBeforeUpdate.historyTracking.state).toBe('untracked');

        const updated = await Page.updatePage(pageBeforeUpdate, 'new content', user, {});

        const reloadedPage = await Page.findById(page._id);
        expect(reloadedPage.historyTracking.state).toBe('ready');
        expect(reloadedPage.historySequence).toBe(1);

        const newRevision = await Revision.findById(updated.revision);
        expect(newRevision?.historySequence).toBe(1);

        // The pre-existing Revisions sit below the tracking boundary —
        // never touched, never sequenced (spec §D-9).
        const reloadedOld1 = await Revision.findById(oldRevision1._id);
        const reloadedOld2 = await Revision.findById(oldRevision2._id);
        expect(reloadedOld1?.historySequence).toBeUndefined();
        expect(reloadedOld2?.historySequence).toBeUndefined();
      });

      test('AC-20: a Page that is never written to stays untracked', async () => {
        const page = await createUntrackedPage('/history-tracking/never-written');

        const reloaded = await Page.findById(page._id);
        expect(reloaded.historyTracking.state).toBe('untracked');
        expect(reloaded.historySequence).toBe(0);
      });
    });

    describe('historyTracking defaults (Phase 1 baseline)', () => {
      test('a Page created via the OTHER Page.create call site (the draft-creation shape used by hono/handlers/draft.ts) starts untracked before its first save', async () => {
        const created = await Page.create({
          path: '/history-tracking/new-draft',
          creator: user._id,
          lastUpdateUser: user._id,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          redirectTo: null,
          grant: Page.GRANT_PUBLIC,
          status: 'draft',
          grantedUsers: [user._id],
        });

        expect(created.historyTracking.state).toBe('untracked');
      });

      test('a legacy Page (predates historyTracking) reads back as untracked — simulated via a raw $unset, which bypasses save hooks', async () => {
        const created = await createUntrackedPage('/history-tracking/legacy');
        expect(created.historyTracking.state).toBe('untracked');

        await Page.updateOne({ _id: created._id }, { $unset: { historyTracking: '' } });
        const reloaded = await Page.findById(created._id);
        expect(reloaded.historyTracking.state).toBe('untracked');
        expect(reloaded.historyTracking.trackingStartedAt).toBeNull();
      });
    });

    describe('pendingHistoryEntry — bounded single-slot outbox (AC-4)', () => {
      // `Page.createPage` now runs the Phase 2a allocator to completion
      // (claim -> materialize -> drain) before it resolves, so by the time
      // these fixtures return, `pendingHistoryEntry` is back to empty — the
      // same starting shape these tests always assumed.
      test('claiming an empty slot succeeds; a second claim attempt while occupied is rejected (not overwritten)', async () => {
        const created = await Page.createPage('/history-tracking/outbox', 'v1', user, {});
        const entryA = {
          entryId: new Types.ObjectId(),
          type: 'content_revision',
          revisionId: new Types.ObjectId(),
          sequence: 1,
          occurredAt: new Date(),
          operationId: 'op-a',
        };
        const entryB = {
          entryId: new Types.ObjectId(),
          type: 'content_revision',
          revisionId: new Types.ObjectId(),
          sequence: 2,
          occurredAt: new Date(),
          operationId: 'op-b',
        };

        const firstClaim = await Page.updateOne({ _id: created._id, pendingHistoryEntry: null }, { $set: { pendingHistoryEntry: entryA } });
        expect(firstClaim.modifiedCount).toBe(1);

        // The slot is now occupied — a second claim attempt using the SAME
        // "must be empty" guard matches nothing and never overwrites entryA.
        const secondClaim = await Page.updateOne({ _id: created._id, pendingHistoryEntry: null }, { $set: { pendingHistoryEntry: entryB } });
        expect(secondClaim.matchedCount).toBe(0);

        const reloaded = await Page.findById(created._id);
        expect(reloaded.pendingHistoryEntry?.operationId).toBe('op-a');
      });

      test('a freshly created Page has no pendingHistoryEntry at all (absent, not an empty array) — the empty-slot claim filter still matches it', async () => {
        const created = await Page.createPage('/history-tracking/outbox-absent', 'v1', user, {});
        expect(created.pendingHistoryEntry).toBeUndefined();

        const entry = {
          entryId: new Types.ObjectId(),
          type: 'migration_revision',
          revisionId: new Types.ObjectId(),
          sequence: 1,
          migrationOwner: 'test-owner',
        };
        const claim = await Page.updateOne({ _id: created._id, pendingHistoryEntry: null }, { $set: { pendingHistoryEntry: entry } });
        expect(claim.modifiedCount).toBe(1);
      });

      test('draining clears the slot by entryId; draining again against the same (now-stale) entryId is a no-op (never clears a newer entry) — AC-5b', async () => {
        const created = await Page.createPage('/history-tracking/outbox-drain', 'v1', user, {});
        const entry = {
          entryId: new Types.ObjectId(),
          type: 'content_revision',
          revisionId: new Types.ObjectId(),
          sequence: 1,
          occurredAt: new Date(),
          operationId: 'op-drain',
        };
        await Page.updateOne({ _id: created._id, pendingHistoryEntry: null }, { $set: { pendingHistoryEntry: entry } });

        // The drain identity filter matches on `entryId` ONLY (RFC §5.5,
        // revised) — never on the entry's other fields.
        const identityFilter = { _id: created._id, 'pendingHistoryEntry.entryId': entry.entryId };
        const drained = await Page.updateOne(identityFilter, { $unset: { pendingHistoryEntry: '' } });
        expect(drained.modifiedCount).toBe(1);

        const reloaded = await Page.findById(created._id);
        expect(reloaded.pendingHistoryEntry).toBeUndefined();

        // The slot is now empty — draining the SAME (now-stale) identity again matches nothing.
        const secondDrain = await Page.updateOne(identityFilter, { $unset: { pendingHistoryEntry: '' } });
        expect(secondDrain.modifiedCount).toBe(0);
      });
    });
  });

  describe('Metadata command wiring (RFC-0021 Phase 2c-1, DC-12)', () => {
    let Revision;
    let PageHistoryEvent;
    let Backlink;
    let actor;

    beforeAll(() => {
      Revision = crowi.model('Revision');
      PageHistoryEvent = crowi.model('PageHistoryEvent');
      Backlink = crowi.model('Backlink');
      actor = createdUsers[0];
    });

    afterEach(async () => {
      const filter = { path: { $regex: '^/dc12' } };
      const pages = await Page.find(filter).select('_id').lean();
      const pageIds = pages.map((p) => p._id);
      await Promise.all([
        Page.deleteMany(filter),
        Revision.deleteMany(filter),
        PageHistoryEvent.deleteMany({ page: { $in: pageIds } }),
        Backlink.deleteMany({ $or: [{ page: { $in: pageIds } }, { fromPage: { $in: pageIds } }] }),
      ]);
    });

    // Same stub shape as `page-lifecycle-epoch.test.ts`'s `withInvalidateSpy`.
    const withInvalidateSpy = async (fn: (invalidatePages: jest.Mock) => Promise<void>) => {
      const invalidatePages = jest.fn(async () => undefined);
      const previous = crowi.collabAttachment;
      crowi.collabAttachment = { invalidatePages, shutdown: async () => undefined };
      try {
        await fn(invalidatePages);
      } finally {
        crowi.collabAttachment = previous;
      }
    };

    // A well-formed-but-permanently-undrainable `page_event` outbox entry:
    // `event.page` deliberately names a DIFFERENT page than the one it's
    // staged in, so `materializePendingEntry` throws on it every time
    // ("outbox entry claims page X but is stored in page Y's slot"),
    // exhausting the grant command's drain-assist budget. Must stay
    // schema-VALID (unlike `page-event-command.test.ts`'s simpler
    // missing-`event` version) because this describe block calls
    // `Page.updatePage`, whose `pushRevision` step runs a full
    // `pageData.save()` — which DOES run `pendingHistoryEntrySchema`'s
    // `pre('validate')` hook, unlike the raw `findOneAndUpdate` the command
    // layer uses.
    const stageJammedOutbox = async (pageId) => {
      await Page.updateOne(
        { _id: pageId },
        {
          $set: {
            pendingHistoryEntry: {
              entryId: new Types.ObjectId(),
              type: 'page_event',
              event: {
                _id: new Types.ObjectId(),
                page: new Types.ObjectId(),
                sequence: 1,
                kind: 'visibility_changed',
                actor: null,
                occurredAt: new Date(),
                operationId: 'stuck-op',
                source: 'system',
                payload: { fromGrant: Page.GRANT_PUBLIC, toGrant: Page.GRANT_RESTRICTED },
              },
            },
          },
        },
      );
    };

    test('AC-24: a contended grant command still fires the body-driven update emit + live-collab invalidation, in order, before throwing — and never mutates the grant (DB or in-memory)', async () => {
      await withInvalidateSpy(async (invalidatePages) => {
        const created = await Page.createPage('/dc12/contended-grant', 'before', actor, {});
        // `allocateContentSequence` promotes the Page via a SEPARATE write
        // after `pushRevision` commits — re-fetch rather than trust the
        // in-memory object `createPage` resolved with.
        expect((await Page.findById(created._id).lean())?.historyTracking?.state).toBe('ready');
        await stageJammedOutbox(created._id);

        const pageEvent = crowi.event('Page');
        const onUpdate = jest.fn();
        pageEvent.once('update', onUpdate);

        const pageData = await Page.findById(created._id);
        await expect(Page.updatePage(pageData, 'after', actor, { grant: Page.GRANT_RESTRICTED })).rejects.toThrow(
          'Page grant update was not committed — retry',
        );

        // The body-driven side effect fired exactly once, off the ORIGINAL grant.
        expect(onUpdate).toHaveBeenCalledTimes(1);
        const [emittedPage] = onUpdate.mock.calls[0];
        expect(emittedPage.grant).toBe(Page.GRANT_PUBLIC);
        expect(invalidatePages).toHaveBeenCalledWith([String(created._id)], 'page-body-replaced');

        // DC-12 requires this exact order (emit, then invalidate) on BOTH
        // the success and the failure path — a reversed order would still
        // satisfy the two assertions above, so pin the order explicitly.
        expect(onUpdate.mock.invocationCallOrder[0]).toBeLessThan(invalidatePages.mock.invocationCallOrder[0]);

        // `pageData` (the caller's own object) was never mutated with the
        // failed grant, and the DB grant is unchanged too.
        expect(pageData.grant).toBe(Page.GRANT_PUBLIC);
        const reloaded = await Page.findById(created._id).select('grant').lean();
        expect(reloaded?.grant).toBe(Page.GRANT_PUBLIC);

        // The body write itself IS durable — this is "body saved, grant
        // unchanged", not a full rollback.
        const revision = await Revision.findById(emittedPage.revision).lean();
        expect(revision?.body).toBe('after');
      });
    });

    // Not a numbered AC, but load-bearing: `Page.updateGrant`'s delegated
    // implementation reads the committed grant back from a fresh
    // `findOneAndUpdate` (unpopulated `revision`/`creator`) rather than
    // reusing the caller's in-memory-populated `pageData` the pre-delegation
    // implementation returned. Without re-populating before returning,
    // `registerBacklinks` (`events/page.ts`, unconditional on every 'update')
    // silently stops re-registering backlinks for every body+grant save —
    // pins the fix.
    test('a body+grant simultaneous save still registers backlinks for links in the new body', async () => {
      const targetPath = '/dc12/backlink-target';
      const sourcePath = '/dc12/backlink-source';
      const target = await Page.createPage(targetPath, '# target', actor, {});
      const source = await Page.createPage(sourcePath, 'no links yet', actor, {});

      const pageData = await Page.findById(source._id);
      await Page.updatePage(pageData, `link: <${targetPath}>`, actor, { grant: Page.GRANT_RESTRICTED });

      const reloadedSource = await Page.findById(source._id).select('grant').lean();
      expect(reloadedSource?.grant).toBe(Page.GRANT_RESTRICTED);

      await crowi.drainSideEffects();
      let backlinks;
      for (let i = 0; i < 50; i += 1) {
        backlinks = await Backlink.find({ page: target._id, fromPage: source._id });
        if (backlinks.length === 1) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(backlinks).toHaveLength(1);
    });
  });
});
