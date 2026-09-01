import { faker } from '@faker-js/faker';
import { crowi, Fixture, randomUsername } from 'src/test/setup';

describe('Share', () => {
  let User;
  let Page;
  let Share;
  let user;
  let createdPages;

  // Pages this block owns, scoped under a unique path prefix so cleanup
  // (and any broad-ish query) never touches another block's seed pages.
  const PATH_PREFIX = '/share-test-' + faker.string.alphanumeric(8) + '/';

  beforeAll(async () => {
    User = crowi.model('User');
    Page = crowi.model('Page');
    Share = crowi.model('Share');

    // This block creates and references its own user/pages directly; it must
    // NOT wipe the shared User/Page tables (that would delete other blocks'
    // seed users and trigger 401 flake on JWT re-auth elsewhere). Scope all
    // owned data and clean up only that.
    const createdUsers = await Fixture.generate('User', [{ name: faker.person.fullName(), username: randomUsername(), email: faker.internet.email() }]);
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
        await expect(Share.createShare(createdPages[0]._id, user)).rejects.toThrow('Cannot create new share.');
      });

      test('should generate a v4 UUID for the uuid field', async () => {
        const share = await Share.createShare(createdPages[0]._id, user);
        expect(share.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      });
    });
  });

  describe('.findShareByUuid', () => {
    test('should find a share by its uuid', async () => {
      const created = await Share.createShare(createdPages[0]._id, user);
      const found = await Share.findShareByUuid(created.uuid);
      expect(found._id.toString()).toBe(created._id.toString());
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
