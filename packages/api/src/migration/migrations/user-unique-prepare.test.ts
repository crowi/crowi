import { Types } from 'mongoose';
import { crowi } from 'src/test/setup';
import type { MigrationDb } from '../types';

import { MigrationRunner } from '../runner';
import { userUniquePrepare } from './user-unique-prepare';

/**
 * RFC-0008 §11 / feature-user-identity-uniqueness — `user-unique-prepare`
 * preflight migration.
 *
 * Covers:
 *   - dedup of living duplicates with reference reassign across the FULL §c
 *     collection/field set (scalar + array, including the bookmark
 *     compound-unique conflict deletion)
 *   - tombstone-deleted of legacy STATUS_DELETED rows
 *   - isPending flips false after apply (no permanent boot block — Phase 3
 *     lesson) and detect reports group/tombstone counts
 */

const STATUS_ACTIVE = 2;
const STATUS_DELETED = 4;

const db = (): MigrationDb => crowi.getMongo().connection.db as MigrationDb;
const oid = () => new Types.ObjectId();

const runner = () => new MigrationRunner(crowi, { logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } });

const clean = async () => {
  const d = db();
  for (const c of ['users', 'pages', 'revisions', 'comments', 'bookmarks', 'attachments', 'shares', 'watchers', 'activities', 'notifications', 'updateposts']) {
    await d.collection(c).deleteMany({ migtest: true });
  }
};

/**
 * Drop the unique username/email indexes so the test can insert the duplicate
 * fixtures the migration is meant to clean up. This mirrors the v1 state: the
 * indexes don't exist yet (the whole point of the preflight migration is to
 * prepare the data so they can be built). `dropIndex` is best-effort — the
 * index name follows the `<field>_1` mongoose convention.
 */
const dropUniqueIndexes = async () => {
  const users = db().collection('users');
  for (const name of ['email_1', 'username_1']) {
    await users.dropIndex(name).catch(() => undefined);
  }
};

describe('migration/user-unique-prepare', () => {
  beforeEach(async () => {
    await clean();
    await dropUniqueIndexes();
  });
  afterEach(clean);

  it('is registered as a preflight migration', () => {
    expect(userUniquePrepare.layer).toBe('preflight');
    expect(userUniquePrepare.id).toBe('user-unique-prepare');
    expect(userUniquePrepare.stages.map((s) => s.name)).toEqual(['dedup-username', 'dedup-email', 'tombstone-deleted']);
  });

  it('dedups a living username collision and reassigns references across the full §c set', async () => {
    const d = db();
    const keepId = oid();
    const dropId = oid();
    const pageId = oid();
    const dropPageId = oid();
    const bookmarkPageShared = oid();

    // keep = oldest + most content; drop = newer, fewer pages.
    await d.collection('users').insertMany([
      { _id: keepId, migtest: true, name: 'Keep', username: 'Sotarok', email: 'keep@example.com', status: STATUS_ACTIVE, createdAt: new Date('2020-01-01') },
      { _id: dropId, migtest: true, name: 'Drop', username: 'sotarok', email: 'drop@example.com', status: STATUS_ACTIVE, createdAt: new Date('2022-01-01') },
    ]);

    // Scalar refs owned by the dropped user. `path` is unique on pages.
    await d.collection('pages').insertMany([
      {
        _id: pageId,
        migtest: true,
        path: `/migtest/${pageId}`,
        creator: keepId,
        lastUpdateUser: dropId,
        grantedUsers: [dropId],
        liker: [dropId, keepId],
        seenUsers: [dropId],
      },
      { _id: dropPageId, migtest: true, path: `/migtest/${dropPageId}`, creator: dropId, lastUpdateUser: dropId, grantedUsers: [], liker: [], seenUsers: [] },
    ]);
    await d.collection('revisions').insertOne({ migtest: true, author: dropId, savedBy: dropId, contributors: [dropId] });
    await d.collection('comments').insertOne({ migtest: true, creator: dropId });
    await d.collection('attachments').insertOne({ migtest: true, creator: dropId });
    await d.collection('shares').insertOne({ migtest: true, creator: dropId });
    await d.collection('watchers').insertOne({ migtest: true, user: dropId });
    await d.collection('activities').insertOne({ migtest: true, user: dropId });
    await d.collection('notifications').insertOne({ migtest: true, user: dropId });
    await d.collection('updateposts').insertOne({ migtest: true, creator: dropId });

    // Bookmark compound-unique conflict: both users bookmark the same page →
    // the dropped row must be deleted (not reassigned) to avoid a collision.
    await d.collection('bookmarks').insertMany([
      { migtest: true, page: bookmarkPageShared, user: keepId },
      { migtest: true, page: bookmarkPageShared, user: dropId },
      { migtest: true, page: oid(), user: dropId }, // non-conflicting → reassigned
    ]);

    await runner().apply(userUniquePrepare);

    // Dropped user gone, survivor (oldest) kept.
    expect(await d.collection('users').findOne({ _id: dropId })).toBeNull();
    expect(await d.collection('users').findOne({ _id: keepId })).not.toBeNull();

    // Scalar reassign.
    expect(await d.collection('pages').findOne({ _id: dropPageId, creator: keepId })).not.toBeNull();
    const p = (await d.collection('pages').findOne({ _id: pageId })) as Record<string, unknown>;
    expect((p.lastUpdateUser as Types.ObjectId).toString()).toBe(keepId.toString());
    // Array reassign: addToSet survivor, pull loser; survivor stays unique.
    expect((p.grantedUsers as Types.ObjectId[]).map(String)).toEqual([keepId.toString()]);
    expect((p.liker as Types.ObjectId[]).map(String).sort()).toEqual([keepId.toString()]);
    expect((p.seenUsers as Types.ObjectId[]).map(String)).toEqual([keepId.toString()]);

    const rev = (await d.collection('revisions').findOne({ migtest: true })) as Record<string, unknown>;
    expect((rev.author as Types.ObjectId).toString()).toBe(keepId.toString());
    expect((rev.savedBy as Types.ObjectId).toString()).toBe(keepId.toString());
    expect((rev.contributors as Types.ObjectId[]).map(String)).toEqual([keepId.toString()]);

    for (const [col, field] of [
      ['comments', 'creator'],
      ['attachments', 'creator'],
      ['shares', 'creator'],
      ['watchers', 'user'],
      ['activities', 'user'],
      ['notifications', 'user'],
      ['updateposts', 'creator'],
    ] as const) {
      const doc = (await d.collection(col).findOne({ migtest: true })) as Record<string, unknown>;
      expect((doc[field] as Types.ObjectId).toString()).toBe(keepId.toString());
    }

    // Bookmarks: conflicting drop row deleted, non-conflicting reassigned.
    const conflictRows = await d.collection('bookmarks').find({ page: bookmarkPageShared, migtest: true }).toArray();
    expect(conflictRows).toHaveLength(1);
    expect((conflictRows[0].user as Types.ObjectId).toString()).toBe(keepId.toString());
    expect(await d.collection('bookmarks').countDocuments({ user: dropId, migtest: true })).toBe(0);
  });

  it('dedups a living email collision (case-folded)', async () => {
    const d = db();
    const keepId = oid();
    const dropId = oid();
    await d.collection('users').insertMany([
      // keep has more content (1 page) so it survives; drop has none.
      { _id: keepId, migtest: true, username: 'mail-keep', email: 'Dup@Example.com', status: STATUS_ACTIVE, createdAt: new Date('2020-01-01') },
      { _id: dropId, migtest: true, username: 'mail-drop', email: 'dup@example.com', status: STATUS_ACTIVE, createdAt: new Date('2021-01-01') },
    ]);
    const pageId = oid();
    // A revision owned by drop, to prove a non-page reference still reassigns.
    await d.collection('pages').insertOne({ _id: pageId, migtest: true, path: `/migtest/${pageId}`, creator: keepId });
    await d.collection('revisions').insertOne({ migtest: true, author: dropId });

    await runner().apply(userUniquePrepare);

    expect(await d.collection('users').findOne({ _id: dropId })).toBeNull();
    const rev = (await d.collection('revisions').findOne({ migtest: true })) as Record<string, unknown>;
    expect((rev.author as Types.ObjectId).toString()).toBe(keepId.toString());
  });

  it('tombstones a legacy DELETED user that collides with a living user', async () => {
    const d = db();
    const livingId = oid();
    const deletedId = oid();
    await d.collection('users').insertMany([
      { _id: livingId, migtest: true, username: 'shared-name', email: 'living@example.com', status: STATUS_ACTIVE, createdAt: new Date('2020-01-01') },
      // Legacy deleted row still holding a real identity colliding the living user.
      { _id: deletedId, migtest: true, username: 'shared-name', email: 'living@example.com', status: STATUS_DELETED, createdAt: new Date('2019-01-01') },
    ]);

    await runner().apply(userUniquePrepare);

    const deleted = (await d.collection('users').findOne({ _id: deletedId })) as Record<string, unknown>;
    expect(deleted.email).toBe(`deleted-${deletedId.toString()}@deleted.invalid`);
    expect(deleted.username).toBe(`deleted-${deletedId.toString()}`);
    // Living user untouched.
    const living = (await d.collection('users').findOne({ _id: livingId })) as Record<string, unknown>;
    expect(living.email).toBe('living@example.com');
  });

  it('isPending flips to false after apply (no permanent boot block) and detect reports counts', async () => {
    const d = db();
    const keepId = oid();
    const dropId = oid();
    const deletedId = oid();
    const livingId = oid();
    await d.collection('users').insertMany([
      { _id: keepId, migtest: true, username: 'Dupe', email: 'a@example.com', status: STATUS_ACTIVE, createdAt: new Date('2020-01-01') },
      { _id: dropId, migtest: true, username: 'dupe', email: 'b@example.com', status: STATUS_ACTIVE, createdAt: new Date('2021-01-01') },
      { _id: livingId, migtest: true, username: 'gone-name', email: 'living2@example.com', status: STATUS_ACTIVE, createdAt: new Date('2020-01-01') },
      { _id: deletedId, migtest: true, username: 'gone-name', email: 'living2@example.com', status: STATUS_DELETED, createdAt: new Date('2019-01-01') },
    ]);

    const r = runner();
    expect(await r.isPending(userUniquePrepare)).toBe(true);

    const report = await r.detect(userUniquePrepare);
    expect(report?.counts?.usernameGroups).toBe(1);
    expect(report?.counts?.tombstoneTargets).toBeGreaterThanOrEqual(1);

    await r.apply(userUniquePrepare);

    // Boot clears: the residual-collision probe is now false.
    expect(await r.isPending(userUniquePrepare)).toBe(false);
  });

  it('dry-run reports without writing', async () => {
    const d = db();
    const keepId = oid();
    const dropId = oid();
    await d.collection('users').insertMany([
      { _id: keepId, migtest: true, username: 'dry-keep', email: 'Dry@example.com', status: STATUS_ACTIVE, createdAt: new Date('2020-01-01') },
      { _id: dropId, migtest: true, username: 'dry-drop', email: 'dry@example.com', status: STATUS_ACTIVE, createdAt: new Date('2021-01-01') },
    ]);

    await new MigrationRunner(crowi, { dryRun: true, logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }).apply(userUniquePrepare);

    // Both users still present — dry-run wrote nothing.
    expect(await d.collection('users').countDocuments({ migtest: true })).toBe(2);
  });
});
