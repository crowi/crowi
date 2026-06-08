import faker from 'faker';
import { crowi, Fixture } from 'src/test/setup';

describe('Share', () => {
  let User;
  let Page;
  let Share;
  let user;
  let createdPages;

  // Pages this block owns, scoped under a unique path prefix so cleanup
  // (and any broad-ish query) never touches another block's seed pages.
  const PATH_PREFIX = '/share-test-' + faker.random.alphaNumeric(8) + '/';

  beforeAll(async () => {
    User = crowi.model('User');
    Page = crowi.model('Page');
    Share = crowi.model('Share');

    // This block creates and references its own user/pages directly; it must
    // NOT wipe the shared User/Page tables (that would delete other blocks'
    // seed users and trigger 401 flake on JWT re-auth elsewhere). Scope all
    // owned data and clean up only that.
    const createdUsers = await Fixture.generate('User', [{ name: faker.name.findName(), username: faker.internet.userName(), email: faker.internet.email() }]);
    user = createdUsers[0];

    createdPages = await Fixture.generate('Page', [
      { path: PATH_PREFIX + faker.lorem.slug(), grant: Page.GRANT_PUBLIC, grantedUsers: [user], creator: user },
      { path: PATH_PREFIX + faker.lorem.slug(), grant: Page.GRANT_PUBLIC, grantedUsers: [user], creator: user },
    ]);
  });

  afterAll(async () => {
    await Promise.all([User.deleteOne({ _id: user._id }), Page.deleteMany({ _id: { $in: createdPages.map((p) => p._id) } })]);
  });

  afterEach(async () => {
    // Shares created by this block all point at this block's pages.
    await Share.deleteMany({ page: { $in: createdPages.map((p) => p._id) } });
  });

  describe('.create', () => {
    describe('Create shares', () => {
      test('should be able to create only one active share per page', async () => {
        await expect(Share.createShare(createdPages[0]._id, user)).resolves.toBeInstanceOf(Share);
        await expect(Share.createShare(createdPages[0]._id, user)).rejects.toThrow();
      });
    });
  });

  describe('.delete', () => {
    describe('Delete share', () => {
      let createdShares;
      beforeAll(async () => {
        createdShares = [await Share.createShare(createdPages[0]._id, user), await Share.createShare(createdPages[1]._id, user)];
      });

      test('should inactivate share', async () => {
        const shareId = createdShares[0]._id;
        await expect(Share.deleteById(shareId)).resolves.toHaveProperty('status', Share.STATUS_INACTIVE);
        const pageId = createdShares[1].page;
        await expect(Share.deleteByPageId(pageId)).resolves.toHaveProperty('status', Share.STATUS_INACTIVE);
      });
    });
  });
});
