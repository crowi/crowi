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
      expect(Page.isDeletableName('/user/xxx/')).toBe(true);
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
      forbidden = ['installer', 'register', 'login', 'logout', 'admin', 'files', 'trash', 'paste', 'comments'];
      for (let i = 0; i < forbidden.length; i++) {
        const pn = forbidden[i];
        expect(Page.isCreatableName('/' + pn + '')).toBe(false);
        expect(Page.isCreatableName('/' + pn + '/')).toBe(false);
        expect(Page.isCreatableName('/' + pn + '/abc')).toBe(false);
      }

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

        await expect(Page.findPageByIdAndGrantedUser(pageToFind._id, grantedUser)).rejects.toThrow();
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
});
