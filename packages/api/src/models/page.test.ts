import { visiblePageGrantOr } from 'src/models/page';
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
});
