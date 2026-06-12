import { crowi } from 'src/test/setup';
import type { UserDocument, UserModel } from 'src/models/user';

/**
 * feature-user-identity-uniqueness — DB-level uniqueness on username / email.
 *
 * Verifies the plain unique + collation (+ sparse on username) indexes built by
 * autoIndex actually reject duplicates at the Mongo layer, that the sparse
 * username index tolerates the INVITED rows created without a username, and
 * that a tombstoned (logically deleted) user frees its name for re-use.
 *
 * `User.createIndexes()` is awaited in `beforeAll` because autoIndex builds
 * asynchronously after boot; without the await the first test could race the
 * build and see no constraint.
 */

const isE11000 = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;

describe('User uniqueness indexes', () => {
  let User: UserModel;

  beforeAll(async () => {
    User = crowi.model('User');
    await User.createIndexes();
  });

  afterEach(async () => {
    await User.deleteMany({ email: { $regex: /uniqtest/ } });
  });

  it('rejects a second user with the same email at the DB layer', async () => {
    await new User({ name: 'A', username: 'uniqtest-email-a', email: 'dup-uniqtest@example.com', status: User.STATUS_ACTIVE }).save();
    await expect(
      new User({ name: 'B', username: 'uniqtest-email-b', email: 'dup-uniqtest@example.com', status: User.STATUS_ACTIVE }).save(),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('rejects a duplicate email differing only in case (collation folds case)', async () => {
    await new User({ name: 'A', username: 'uniqtest-case-a', email: 'Case-uniqtest@example.com', status: User.STATUS_ACTIVE }).save();
    await expect(
      new User({ name: 'B', username: 'uniqtest-case-b', email: 'case-uniqtest@example.com', status: User.STATUS_ACTIVE }).save(),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('rejects a second user with the same username (case-folded)', async () => {
    await new User({ name: 'A', username: 'Uniqtest-Name', email: 'name-a-uniqtest@example.com', status: User.STATUS_ACTIVE }).save();
    await expect(
      new User({ name: 'B', username: 'uniqtest-name', email: 'name-b-uniqtest@example.com', status: User.STATUS_ACTIVE }).save(),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('allows multiple INVITED users with no username (sparse index)', async () => {
    // createUsersByInvitation creates rows with NO username field set.
    const a = await new User({ email: 'invited-a-uniqtest@example.com', status: User.STATUS_INVITED }).save();
    const b = await new User({ email: 'invited-b-uniqtest@example.com', status: User.STATUS_INVITED }).save();
    expect(a.username).toBeUndefined();
    expect(b.username).toBeUndefined();
  });

  it('frees the username/email for re-use after a user is logically deleted (tombstone)', async () => {
    const original = await new User({ name: 'Departing', username: 'uniqtest-reuse', email: 'reuse-uniqtest@example.com', status: User.STATUS_ACTIVE }).save();

    await new Promise<void>((resolve, reject) => {
      original.statusDelete((err: Error | null) => (err ? reject(err) : resolve()));
    });

    const reloaded = (await User.findById(original._id)) as UserDocument;
    // Original identity is discarded; tombstone values written in its place.
    expect(reloaded.email).toBe(`deleted-${original._id.toString()}@deleted.invalid`);
    expect(reloaded.username).toBe(`deleted-${original._id.toString()}`);

    // A living user can now re-claim the freed name/email.
    const reclaim = await new User({ name: 'New Owner', username: 'uniqtest-reuse', email: 'reuse-uniqtest@example.com', status: User.STATUS_ACTIVE }).save();
    expect(reclaim.email).toBe('reuse-uniqtest@example.com');
    await User.deleteMany({ _id: { $in: [original._id, reclaim._id] } });
  });

  it('keeps two tombstoned (deleted) users from colliding on the shared sentinel', async () => {
    const a = await new User({ name: 'Del A', username: 'uniqtest-del-a', email: 'del-a-uniqtest@example.com', status: User.STATUS_ACTIVE }).save();
    const b = await new User({ name: 'Del B', username: 'uniqtest-del-b', email: 'del-b-uniqtest@example.com', status: User.STATUS_ACTIVE }).save();

    const del = (u: UserDocument) => new Promise<void>((resolve, reject) => u.statusDelete((err: Error | null) => (err ? reject(err) : resolve())));
    await del(a);
    // The per-id tombstone (vs the old fixed `deleted@deleted`) means the
    // second delete does not collide on the unique email index.
    await expect(del(b)).resolves.toBeUndefined();
    await User.deleteMany({ _id: { $in: [a._id, b._id] } });
  });

  it('isDuplicateKeyError recognises the raised E11000', async () => {
    await new User({ name: 'A', username: 'uniqtest-probe-a', email: 'probe-uniqtest@example.com', status: User.STATUS_ACTIVE }).save();
    try {
      await new User({ name: 'B', username: 'uniqtest-probe-b', email: 'probe-uniqtest@example.com', status: User.STATUS_ACTIVE }).save();
      throw new Error('expected a duplicate-key error');
    } catch (err) {
      expect(isE11000(err)).toBe(true);
    }
  });
});
