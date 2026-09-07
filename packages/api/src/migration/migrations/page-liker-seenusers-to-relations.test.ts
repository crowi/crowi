import { Types } from 'mongoose';
import { crowi } from 'src/test/setup';
import type { MigrationApplicationModel } from 'src/models/migration-application';

import { MigrationCliApi } from '../cli-api';
import { allMigrations } from '../migrations';
import { createRegistry, MigrationRegistry } from '../registry';
import { PreflightBlockedError, runBootMigrations } from '../run-boot-migrations';
import { MigrationRunner, noopProgress } from '../runner';
import { defineMigration, type MigrationContext, type MigrationDb } from '../types';
import {
  LEGACY_FIELD_FILTER,
  normalizeLegacyUserIds,
  PAGE_BATCH_SIZE,
  PageRelationMigrationError,
  pageLikerSeenUsersToRelations,
} from './page-liker-seenusers-to-relations';

/**
 * feature-page-relations-cutover — `page-liker-seenusers-to-relations`.
 *
 * Test names carry the spec's AC number (test plan table) so a reviewer can
 * diff this file against `.feature-state/specs/feature-page-relations-cutover.md`
 * row by row.
 */

const [prepareTargetIndexStage, copyRelationsStage, verifyRelationsStage, unsetLegacyFieldsStage] = pageLikerSeenUsersToRelations.stages;

const db = (): MigrationDb => crowi.getMongo().connection.db as MigrationDb;
const oid = () => new Types.ObjectId();
const noopLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

const MigrationApplication = () => crowi.model('MigrationApplication') as MigrationApplicationModel;

function makeRunner(opts: { dryRun?: boolean } = {}): MigrationRunner {
  return new MigrationRunner(crowi, { logger: noopLogger, progress: noopProgress, dryRun: opts.dryRun });
}

function makeContext(opts: { dryRun?: boolean } = {}): MigrationContext {
  return makeRunner(opts).context;
}

async function insertLegacyPage(fields: { liker?: unknown; seenUsers?: unknown } = {}): Promise<Types.ObjectId> {
  const _id = oid();
  const doc: Record<string, unknown> = { _id, path: `/__cutover/${_id.toHexString()}` };
  if ('liker' in fields) doc.liker = fields.liker;
  if ('seenUsers' in fields) doc.seenUsers = fields.seenUsers;
  await db().collection('pages').insertOne(doc);
  return _id;
}

async function likeRows(): Promise<{ page: Types.ObjectId; user: Types.ObjectId; createdAt: Date | null }[]> {
  return db().collection('likes').find({}).toArray() as unknown as { page: Types.ObjectId; user: Types.ObjectId; createdAt: Date | null }[];
}

async function seenRows(): Promise<{ page: Types.ObjectId; user: Types.ObjectId; createdAt: Date | null }[]> {
  return db().collection('seens').find({}).toArray() as unknown as { page: Types.ObjectId; user: Types.ObjectId; createdAt: Date | null }[];
}

async function dropCompoundUniqueIndex(name: 'likes' | 'seens'): Promise<void> {
  const collection = db().collection(name);
  const indexes = await collection.indexes();
  const compound = indexes.find((idx) => idx.unique === true && Object.keys(idx.key).length === 2 && idx.key.page === 1 && idx.key.user === 1);
  if (compound?.name) {
    await collection.dropIndex(compound.name);
  }
}

/**
 * Raw `ctx.db.collection(name)` calls (the mongodb driver, not a Mongoose
 * model) return a NEW wrapper object on every call — unlike a Mongoose
 * model's `.collection` (a stable, cached property) — so spying on a
 * separately-obtained `db().collection(name)` object never observes calls
 * the migration makes through its OWN `ctx.db.collection(name)` call.
 * Intercept at the `Db.collection` factory instead, patching the exact
 * instance it hands back before returning it.
 */
function captureDbCollectionMethodOptions(
  targetDb: MigrationDb,
  collectionName: string,
  methodName: 'find' | 'findOne',
): { calls: unknown[][]; restore: () => void } {
  const calls: unknown[][] = [];
  const originalCollection = targetDb.collection.bind(targetDb);
  const spy = jest.spyOn(targetDb, 'collection').mockImplementation(((name: string, options?: unknown) => {
    const coll = originalCollection(name, options as never);
    if (name === collectionName) {
      const orig = (coll[methodName] as (...a: unknown[]) => unknown).bind(coll);
      (coll as unknown as Record<string, unknown>)[methodName] = (...args: unknown[]) => {
        calls.push(args);
        return orig(...args);
      };
    }
    return coll;
  }) as typeof targetDb.collection);
  return { calls, restore: () => spy.mockRestore() };
}

async function restoreIndexes(): Promise<void> {
  await crowi.model('Like').ensureUniqueIndex();
  await crowi.model('Seen').ensureUniqueIndex();
}

async function cleanAll(): Promise<void> {
  await db().collection('pages').deleteMany(LEGACY_FIELD_FILTER);
  await db().collection('likes').deleteMany({});
  await db().collection('seens').deleteMany({});
  await MigrationApplication().deleteMany({ migrationId: pageLikerSeenUsersToRelations.id });
}

beforeEach(cleanAll);
afterEach(async () => {
  await cleanAll();
  await restoreIndexes();
});

describe('normalizeLegacyUserIds (D-5 / C-VALIDATION, AC-5)', () => {
  it('field absent -> empty, no elements counted at all', () => {
    expect(normalizeLegacyUserIds(undefined, false)).toEqual({
      userIds: [],
      inputElements: 0,
      droppedElements: 0,
      deduplicatedElements: 0,
      nonArrayLegacyFields: 0,
    });
  });

  it('an array of ObjectId instances and 24-hex strings is kept, mixed case hex accepted', () => {
    const a = oid();
    const bHex = oid().toHexString().toUpperCase();
    const result = normalizeLegacyUserIds([a, bHex], true);
    expect(result.userIds.map((id) => id.toHexString())).toEqual(expect.arrayContaining([a.toHexString(), bHex.toLowerCase()]));
    expect(result.userIds).toHaveLength(2);
    expect(result.inputElements).toBe(2);
    expect(result.droppedElements).toBe(0);
    expect(result.deduplicatedElements).toBe(0);
    expect(result.nonArrayLegacyFields).toBe(0);
  });

  it('drops invalid elements (wrong-length string, number, null, object) without throwing', () => {
    const valid = oid();
    const result = normalizeLegacyUserIds([valid, 'too-short', 12345, null, { not: 'an id' }], true);
    expect(result.userIds).toEqual([valid]);
    expect(result.inputElements).toBe(5);
    expect(result.droppedElements).toBe(4);
    expect(result.deduplicatedElements).toBe(0);
  });

  it('deduplicates a repeated id within one page, counting the repeats (not the first) as deduplicatedElements', () => {
    const a = oid();
    const result = normalizeLegacyUserIds([a, a, a], true);
    expect(result.userIds).toEqual([a]);
    expect(result.inputElements).toBe(3);
    expect(result.deduplicatedElements).toBe(2);
    expect(result.droppedElements).toBe(0);
  });

  it('a non-array present field is treated as one input element (nonArrayLegacyFields:1)', () => {
    const scalar = oid();
    const result = normalizeLegacyUserIds(scalar, true);
    expect(result.userIds).toEqual([scalar]);
    expect(result.inputElements).toBe(1);
    expect(result.nonArrayLegacyFields).toBe(1);
    expect(result.droppedElements).toBe(0);
  });

  it('a non-array present INVALID field counts nonArrayLegacyFields AND droppedElements (both apply)', () => {
    const result = normalizeLegacyUserIds('not-an-id', true);
    expect(result.userIds).toEqual([]);
    expect(result.nonArrayLegacyFields).toBe(1);
    expect(result.droppedElements).toBe(1);
  });
});

describe('AC-1: migration identity, barrel order, data-derived primary pending', () => {
  it('has the exact D-4 identity', () => {
    expect(pageLikerSeenUsersToRelations.id).toBe('page-liker-seenusers-to-relations');
    expect(pageLikerSeenUsersToRelations.fromVersion).toBe('1.x');
    expect(pageLikerSeenUsersToRelations.toVersion).toBe('2.0');
    expect(pageLikerSeenUsersToRelations.layer).toBe('preflight');
    expect(pageLikerSeenUsersToRelations.severity).toBe('blocking');
    expect(pageLikerSeenUsersToRelations.order).toBeUndefined();
  });

  it('is registered in the migrations barrel, appended at the end', () => {
    expect(allMigrations[allMigrations.length - 1]).toBe(pageLikerSeenUsersToRelations);
    expect(createRegistry().get('page-liker-seenusers-to-relations')).toBe(pageLikerSeenUsersToRelations);
  });

  it('isPending is true for an empty liker array (field presence, not truthiness) and false once clean', async () => {
    await insertLegacyPage({ liker: [] });
    expect(await pageLikerSeenUsersToRelations.isPending(makeContext())).toBe(true);
  });

  it('isPending is true for an empty seenUsers array too', async () => {
    await insertLegacyPage({ seenUsers: [] });
    expect(await pageLikerSeenUsersToRelations.isPending(makeContext())).toBe(true);
  });

  it('isPending is false on a clean database', async () => {
    expect(await pageLikerSeenUsersToRelations.isPending(makeContext())).toBe(false);
  });

  it('isPending reads with readPreference: primary', async () => {
    await insertLegacyPage({ liker: [oid()] });
    const capture = captureDbCollectionMethodOptions(db(), 'pages', 'findOne');
    try {
      await pageLikerSeenUsersToRelations.isPending(makeContext());
    } finally {
      capture.restore();
    }
    const [, options] = capture.calls[0] as [unknown, { readPreference?: string }];
    expect(options?.readPreference).toBe('primary');
  });
});

describe('AC-2: detect / CLI side-effect / dry-run', () => {
  it('detect reports every D-4 count, and the one-line summary reflects every one of them (not just pages/valid counts)', async () => {
    const validA = oid();
    const validB = oid();
    await insertLegacyPage({ liker: [validA, validA, 'bad'], seenUsers: validB });

    const report = await pageLikerSeenUsersToRelations.detect(makeContext());
    expect(report?.counts).toMatchObject({
      pages: 1,
      likerElements: 3,
      seenUserElements: 1,
      validLikeRelations: 1,
      validSeenRelations: 1,
      droppedLikerElements: 1,
      droppedSeenUserElements: 0,
      deduplicatedLikerElements: 1,
      deduplicatedSeenUserElements: 0,
      nonArrayLikerFields: 0,
      nonArraySeenUsersFields: 1,
    });
    // `migrate plan` (text mode) prints only `summary` — every D-4 count must
    // be legible there too, not just in the programmatic `counts` object.
    // A full-string `toBe` (not `toContain`) pins liker/seenUsers to their
    // OWN counts — several count values are shared between segments, so a
    // swapped liker<->seenUsers count would still pass loose substring checks.
    expect(report?.summary).toBe(
      '1 page(s) with legacy liker/seenUsers: ' +
        'liker 3 element(s) -> 1 valid (1 dropped, 1 deduplicated, 0 non-array field(s)); ' +
        'seenUsers 1 element(s) -> 1 valid (0 dropped, 0 deduplicated, 1 non-array field(s))',
    );
  });

  it('a runner dry-run applies no writes and reports detect counts as stats', async () => {
    await insertLegacyPage({ liker: [oid()] });
    const runner = makeRunner({ dryRun: true });
    const outcome = await runner.apply(pageLikerSeenUsersToRelations);
    expect(outcome.stats).toMatchObject({ pages: 1, validLikeRelations: 1 });
    expect(await likeRows()).toHaveLength(0);
    expect(await db().collection('pages').countDocuments(LEGACY_FIELD_FILTER)).toBe(1);
  });

  it('stage 1 direct dry-run reports the planned static-call count, no index build', async () => {
    const Like = crowi.model('Like');
    const Seen = crowi.model('Seen');
    const likeSpy = jest.spyOn(Like, 'ensureUniqueIndex');
    const seenSpy = jest.spyOn(Seen, 'ensureUniqueIndex');
    let likeCalls: number;
    let seenCalls: number;
    try {
      const result = await prepareTargetIndexStage.fn(makeContext({ dryRun: true }));
      expect(result).toMatchObject({ name: 'prepare-target-index', transformed: 0, stats: { indexEnsureCallsPlanned: 2 } });
      // Read call counts BEFORE mockRestore() — restoring clears `mock.calls`.
      likeCalls = likeSpy.mock.calls.length;
      seenCalls = seenSpy.mock.calls.length;
    } finally {
      likeSpy.mockRestore();
      seenSpy.mockRestore();
    }
    expect(likeCalls).toBe(0);
    expect(seenCalls).toBe(0);
  });

  it('stage 2 direct dry-run reports upsert-attempt + normalization stats without writing', async () => {
    await insertLegacyPage({ liker: [oid()] });
    const result = await copyRelationsStage.fn(makeContext({ dryRun: true }));
    expect(result.transformed).toBe(0);
    expect(result.stats).toMatchObject({ likeUpsertAttempts: 1, seenUpsertAttempts: 0 });
    expect(await likeRows()).toHaveLength(0);
  });

  it('stage 3 direct dry-run reports the expected relation counts without writing or throwing', async () => {
    await insertLegacyPage({ liker: [oid()] });
    const result = await verifyRelationsStage.fn(makeContext({ dryRun: true }));
    expect(result).toMatchObject({ name: 'verify-relations', transformed: 0, stats: { likeRelationsToVerify: 1, seenRelationsToVerify: 0 } });
  });

  it('stage 4 direct dry-run reports pagesToUnset without unsetting', async () => {
    await insertLegacyPage({ liker: [oid()] });
    const result = await unsetLegacyFieldsStage.fn(makeContext({ dryRun: true }));
    expect(result).toMatchObject({ name: 'unset-legacy-fields', transformed: 0, stats: { pagesToUnset: 1 } });
    expect(await db().collection('pages').countDocuments(LEGACY_FIELD_FILTER)).toBe(1);
  });

  it('CLI plan (isPending + detect only) never writes to likes/seens/pages and never builds the relation index', async () => {
    await insertLegacyPage({ liker: [oid()] });
    const registry = new MigrationRegistry([pageLikerSeenUsersToRelations]);
    const api = new MigrationCliApi(crowi, registry);
    const Like = crowi.model('Like');
    const Seen = crowi.model('Seen');
    const likeSpy = jest.spyOn(Like, 'ensureUniqueIndex');
    const seenSpy = jest.spyOn(Seen, 'ensureUniqueIndex');
    let likeCalls: number;
    let seenCalls: number;
    try {
      const entries = await api.plan();
      expect(entries.find((e) => e.id === pageLikerSeenUsersToRelations.id)?.pending).toBe(true);
      likeCalls = likeSpy.mock.calls.length;
      seenCalls = seenSpy.mock.calls.length;
    } finally {
      likeSpy.mockRestore();
      seenSpy.mockRestore();
    }
    expect(likeCalls).toBe(0);
    expect(seenCalls).toBe(0);
    expect(await likeRows()).toHaveLength(0);
    expect(await db().collection('pages').countDocuments(LEGACY_FIELD_FILTER)).toBe(1);
  });
});

describe('AC-3: prepare-target-index — index static, duplicate diagnosis, no code() branching', () => {
  it('stage 1 never touches ctx.db.collection at all — Like/Seen are resolved only via ctx.crowi.model(...)', async () => {
    const ctx = makeContext();
    const dbCollectionSpy = jest.spyOn(ctx.db, 'collection');
    let calls: number;
    try {
      await prepareTargetIndexStage.fn(ctx);
      calls = dbCollectionSpy.mock.calls.length;
    } finally {
      dbCollectionSpy.mockRestore();
    }
    expect(calls).toBe(0);
  });

  it('is idempotent against an already-built index', async () => {
    const ctx = makeContext();
    await expect(prepareTargetIndexStage.fn(ctx)).resolves.toMatchObject({ name: 'prepare-target-index' });
    await expect(prepareTargetIndexStage.fn(ctx)).resolves.toMatchObject({ name: 'prepare-target-index' });
  });

  it('reports a bounded, sanitized PageRelationMigrationError from a CODELESS ensureUniqueIndex failure when real duplicates exist', async () => {
    await dropCompoundUniqueIndex('likes');
    const page = oid();
    const user = oid();
    await db()
      .collection('likes')
      .insertMany([
        { page, user, createdAt: null },
        { page, user, createdAt: null },
      ]);

    const Like = crowi.model('Like');
    const ensureSpy = jest.spyOn(Like, 'ensureUniqueIndex').mockRejectedValueOnce(new Error('index build failed, no .code here'));
    try {
      await prepareTargetIndexStage.fn(makeContext());
      throw new Error('expected prepareTargetIndexStage to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(PageRelationMigrationError);
      const e = err as PageRelationMigrationError;
      expect(e.stats.duplicateLikes).toBe(1);
      expect(e.stats.duplicateSeens).toBe(0);
      expect(e.stats.samples).toEqual([{ kind: 'duplicate-like', pageId: page.toHexString(), userId: user.toHexString(), count: 2 }]);
    } finally {
      ensureSpy.mockRestore();
    }
  });

  it('reports duplicates from a REAL E11000 raised by createIndexes() once the compound index is dropped', async () => {
    await dropCompoundUniqueIndex('likes');
    const page = oid();
    const user = oid();
    await db()
      .collection('likes')
      .insertMany([
        { page, user, createdAt: null },
        { page, user, createdAt: null },
      ]);

    await expect(prepareTargetIndexStage.fn(makeContext())).rejects.toBeInstanceOf(PageRelationMigrationError);
  });

  it('rethrows the ORIGINAL error unchanged when ensureUniqueIndex fails but no duplicates exist', async () => {
    const original = new Error('unrelated failure (e.g. connection reset)');
    const Like = crowi.model('Like');
    const ensureSpy = jest.spyOn(Like, 'ensureUniqueIndex').mockRejectedValueOnce(original);
    try {
      await expect(prepareTargetIndexStage.fn(makeContext())).rejects.toBe(original);
    } finally {
      ensureSpy.mockRestore();
    }
  });

  it('rethrows the ORIGINAL ensureUniqueIndex error, not the diagnostic aggregation error, when the diagnostic itself throws', async () => {
    const original = new Error('index build failed');
    const diagFailure = new Error('aggregation exploded');
    const Like = crowi.model('Like');
    const ensureSpy = jest.spyOn(Like, 'ensureUniqueIndex').mockRejectedValueOnce(original);
    const aggregateSpy = jest.spyOn(Like.collection, 'aggregate').mockImplementationOnce(() => {
      throw diagFailure;
    });
    try {
      await expect(prepareTargetIndexStage.fn(makeContext())).rejects.toBe(original);
    } finally {
      ensureSpy.mockRestore();
      aggregateSpy.mockRestore();
    }
  });

  it('rethrows a SEEN-only ensureUniqueIndex rejection unchanged (not just Like)', async () => {
    const original = new Error('seen index build failed, unrelated to duplicates');
    const Seen = crowi.model('Seen');
    const ensureSpy = jest.spyOn(Seen, 'ensureUniqueIndex').mockRejectedValueOnce(original);
    try {
      await expect(prepareTargetIndexStage.fn(makeContext())).rejects.toBe(original);
    } finally {
      ensureSpy.mockRestore();
    }
  });

  it('the stage does not settle until a deferred Seen.ensureUniqueIndex resolves (proves it is awaited, not fire-and-forget)', async () => {
    const Seen = crowi.model('Seen');
    let resolveSeen: (() => void) | undefined;
    const seenDeferred = new Promise<void>((resolve) => {
      resolveSeen = resolve;
    });
    const seenSpy = jest.spyOn(Seen, 'ensureUniqueIndex').mockImplementationOnce(() => seenDeferred);
    try {
      let settled = false;
      const resultPromise = prepareTargetIndexStage.fn(makeContext()).then(() => {
        settled = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      resolveSeen?.();
      await resultPromise;
      expect(settled).toBe(true);
    } finally {
      seenSpy.mockRestore();
    }
  });

  it('awaits Like.ensureUniqueIndex before calling Seen.ensureUniqueIndex — a fire-and-forget Like call would let Seen start early', async () => {
    const Like = crowi.model('Like');
    const Seen = crowi.model('Seen');
    let likeResolved = false;
    let seenCalledBeforeLikeResolved = false;
    let resolveLike: (() => void) | undefined;
    const likeDeferred = new Promise<void>((resolve) => {
      resolveLike = resolve;
    });
    const likeSpy = jest.spyOn(Like, 'ensureUniqueIndex').mockImplementationOnce(async () => {
      await likeDeferred;
      likeResolved = true;
    });
    const seenSpy = jest.spyOn(Seen, 'ensureUniqueIndex').mockImplementationOnce(async () => {
      seenCalledBeforeLikeResolved = !likeResolved;
    });
    try {
      const resultPromise = prepareTargetIndexStage.fn(makeContext());
      // Give the stage a chance to reach Seen.ensureUniqueIndex if (incorrectly) not awaiting Like.
      await Promise.resolve();
      await Promise.resolve();
      expect(seenSpy).not.toHaveBeenCalled();
      resolveLike?.();
      await resultPromise;
    } finally {
      likeSpy.mockRestore();
      seenSpy.mockRestore();
    }
    expect(seenCalledBeforeLikeResolved).toBe(false);
  });

  it('a stage-1 failure prevents copy from ever running (subsequent stages not reached)', async () => {
    await dropCompoundUniqueIndex('likes');
    const page = oid();
    const user = oid();
    await db()
      .collection('likes')
      .insertMany([
        { page, user, createdAt: null },
        { page, user, createdAt: null },
      ]);
    await insertLegacyPage({ liker: [oid()] });

    await expect(makeRunner().apply(pageLikerSeenUsersToRelations)).rejects.toBeInstanceOf(PageRelationMigrationError);
    // copy never ran: the unrelated legacy page's relation was never copied.
    expect(await likeRows()).toHaveLength(2);
    expect(await db().collection('pages').countDocuments(LEGACY_FIELD_FILTER)).toBe(1);
  });
});

describe('AC-4: copy-relations — model-collection handle, upsert-only asymmetry, E11000 classification, no target pre-read', () => {
  it('copies missing-source relations into the target using the Like/Seen model .collection handle', async () => {
    const likeUser = oid();
    const seenUser = oid();
    await insertLegacyPage({ liker: [likeUser], seenUsers: [seenUser] });

    const result = await copyRelationsStage.fn(makeContext());
    expect(result.stats).toMatchObject({ pagesScanned: 1, likesUpserted: 1, seensUpserted: 1 });

    const likes = await likeRows();
    expect(likes).toHaveLength(1);
    expect(likes[0].user.toHexString()).toBe(likeUser.toHexString());
    expect(likes[0].createdAt).toBeNull();

    const seens = await seenRows();
    expect(seens).toHaveLength(1);
    expect(seens[0].user.toHexString()).toBe(seenUser.toHexString());
    expect(seens[0].createdAt).toBeNull();
  });

  it('never deletes an existing target row that has no matching legacy source (upsert-only asymmetry)', async () => {
    const livePage = oid();
    const liveUser = oid();
    await db().collection('likes').insertOne({ page: livePage, user: liveUser, createdAt: new Date() });

    await insertLegacyPage({ liker: [oid()] });
    await copyRelationsStage.fn(makeContext());

    const likes = await likeRows();
    expect(likes).toHaveLength(2);
    expect(likes.some((r) => r.page.toHexString() === livePage.toHexString() && r.user.toHexString() === liveUser.toHexString())).toBe(true);
  });

  it('classifies an all-E11000 bulk failure with no write-concern error as a tolerated success', async () => {
    await insertLegacyPage({ liker: [oid()] });
    const Like = crowi.model('Like');
    const bulkWriteSpy = jest.spyOn(Like.collection, 'bulkWrite').mockRejectedValueOnce({
      name: 'MongoBulkWriteError',
      writeErrors: [{ code: 11000 }],
      result: { upsertedCount: 1, getWriteConcernError: () => null },
    });
    try {
      const result = await copyRelationsStage.fn(makeContext());
      expect(result.stats).toMatchObject({ likesUpserted: 1 });
    } finally {
      bulkWriteSpy.mockRestore();
    }
  });

  it('rethrows a bulk failure with a non-11000 code mixed in', async () => {
    await insertLegacyPage({ liker: [oid()] });
    const Like = crowi.model('Like');
    const mixedError = {
      name: 'MongoBulkWriteError',
      writeErrors: [{ code: 11000 }, { code: 12345 }],
      result: { upsertedCount: 0, getWriteConcernError: () => null },
    };
    const bulkWriteSpy = jest.spyOn(Like.collection, 'bulkWrite').mockRejectedValueOnce(mixedError);
    try {
      await expect(copyRelationsStage.fn(makeContext())).rejects.toBe(mixedError);
    } finally {
      bulkWriteSpy.mockRestore();
    }
  });

  it('rethrows an all-E11000 bulk failure that ALSO carries a write concern error', async () => {
    await insertLegacyPage({ liker: [oid()] });
    const Like = crowi.model('Like');
    const wceError = {
      name: 'MongoBulkWriteError',
      writeErrors: [{ code: 11000 }],
      result: { upsertedCount: 1, getWriteConcernError: () => ({ code: 64, errmsg: 'wtimeout' }) },
    };
    const bulkWriteSpy = jest.spyOn(Like.collection, 'bulkWrite').mockRejectedValueOnce(wceError);
    try {
      await expect(copyRelationsStage.fn(makeContext())).rejects.toBe(wceError);
    } finally {
      bulkWriteSpy.mockRestore();
    }
  });

  it('rethrows an all-E11000 result that is missing upsertedCount (malformed, would otherwise coerce to NaN)', async () => {
    await insertLegacyPage({ liker: [oid()] });
    const Like = crowi.model('Like');
    const noUpsertedCountError = {
      name: 'MongoBulkWriteError',
      writeErrors: [{ code: 11000 }],
      result: { getWriteConcernError: () => null },
    };
    const bulkWriteSpy = jest.spyOn(Like.collection, 'bulkWrite').mockRejectedValueOnce(noUpsertedCountError);
    try {
      await expect(copyRelationsStage.fn(makeContext())).rejects.toBe(noUpsertedCountError);
    } finally {
      bulkWriteSpy.mockRestore();
    }
  });

  it('rethrows an all-E11000 result whose upsertedCount is NaN (malformed, not a valid count)', async () => {
    await insertLegacyPage({ liker: [oid()] });
    const Like = crowi.model('Like');
    const nanUpsertedCountError = {
      name: 'MongoBulkWriteError',
      writeErrors: [{ code: 11000 }],
      result: { upsertedCount: Number.NaN, getWriteConcernError: () => null },
    };
    const bulkWriteSpy = jest.spyOn(Like.collection, 'bulkWrite').mockRejectedValueOnce(nanUpsertedCountError);
    try {
      await expect(copyRelationsStage.fn(makeContext())).rejects.toBe(nanUpsertedCountError);
    } finally {
      bulkWriteSpy.mockRestore();
    }
  });

  it('rethrows a bulk failure with an empty writeErrors array', async () => {
    await insertLegacyPage({ liker: [oid()] });
    const Like = crowi.model('Like');
    const emptyError = { name: 'MongoBulkWriteError', writeErrors: [], result: { upsertedCount: 0, getWriteConcernError: () => null } };
    const bulkWriteSpy = jest.spyOn(Like.collection, 'bulkWrite').mockRejectedValueOnce(emptyError);
    try {
      await expect(copyRelationsStage.fn(makeContext())).rejects.toBe(emptyError);
    } finally {
      bulkWriteSpy.mockRestore();
    }
  });

  it('never reads the target collections before writing (0 find calls)', async () => {
    await insertLegacyPage({ liker: [oid()], seenUsers: [oid()] });
    const Like = crowi.model('Like');
    const Seen = crowi.model('Seen');
    const likeFindSpy = jest.spyOn(Like.collection, 'find');
    const seenFindSpy = jest.spyOn(Seen.collection, 'find');
    let likeCalls: number;
    let seenCalls: number;
    try {
      await copyRelationsStage.fn(makeContext());
      // Read call counts BEFORE mockRestore() — restoring clears `mock.calls`,
      // so an assertion made after restore would trivially pass either way.
      likeCalls = likeFindSpy.mock.calls.length;
      seenCalls = seenFindSpy.mock.calls.length;
    } finally {
      likeFindSpy.mockRestore();
      seenFindSpy.mockRestore();
    }
    expect(likeCalls).toBe(0);
    expect(seenCalls).toBe(0);
  });

  it('copy and verify resolve the source only via ctx.db.collection("pages") — never a literal "likes"/"seens" name', async () => {
    await insertLegacyPage({ liker: [oid()] });
    const ctx = makeContext();
    const dbCollectionSpy = jest.spyOn(ctx.db, 'collection');
    let names: unknown[];
    try {
      await copyRelationsStage.fn(ctx);
      await verifyRelationsStage.fn(ctx);
      names = dbCollectionSpy.mock.calls.map((c) => c[0]);
    } finally {
      dbCollectionSpy.mockRestore();
    }
    // A non-empty, "pages"-only result proves the spy observed real calls —
    // an empty `names` would make the `not.toContain` assertions vacuous.
    expect(names).toContain('pages');
    expect(names).not.toContain('likes');
    expect(names).not.toContain('seens');
  });
});

describe('AC-4/AC-6: primary-pinned reads (source cursor, verify target find, stage-1 duplicate aggregation, detect)', () => {
  it('copy source cursor is pinned to primary', async () => {
    await insertLegacyPage({ liker: [oid()] });
    const capture = captureDbCollectionMethodOptions(db(), 'pages', 'find');
    try {
      await copyRelationsStage.fn(makeContext());
    } finally {
      capture.restore();
    }
    const [, options] = capture.calls[0] as [unknown, { readPreference?: string }];
    expect(options?.readPreference).toBe('primary');
  });

  it("verify's target find is pinned to primary", async () => {
    const user = oid();
    await insertLegacyPage({ liker: [user] });
    await copyRelationsStage.fn(makeContext());

    const Like = crowi.model('Like');
    const findSpy = jest.spyOn(Like.collection, 'find');
    let firstCallArgs: unknown[] | undefined;
    try {
      await verifyRelationsStage.fn(makeContext());
      firstCallArgs = findSpy.mock.calls[0];
    } finally {
      findSpy.mockRestore();
    }
    const [, options] = firstCallArgs as [unknown, { readPreference?: string }];
    expect(options?.readPreference).toBe('primary');
  });

  it("stage 1's duplicate diagnostic aggregation is pinned to primary", async () => {
    const original = new Error('index build failed');
    const Like = crowi.model('Like');
    const ensureSpy = jest.spyOn(Like, 'ensureUniqueIndex').mockRejectedValueOnce(original);
    const aggregateSpy = jest.spyOn(Like.collection, 'aggregate');
    try {
      await prepareTargetIndexStage.fn(makeContext());
    } catch {
      // rethrows `original` (no duplicates) — irrelevant to this assertion.
    } finally {
      ensureSpy.mockRestore();
    }
    const [, options] = aggregateSpy.mock.calls[0] as [unknown, { readPreference?: string }];
    expect(options?.readPreference).toBe('primary');
    aggregateSpy.mockRestore();
  });

  it('detect scans with readPreference: primary too (same replica-lag rationale as isPending, F-4 step 2)', async () => {
    await insertLegacyPage({ liker: [oid()] });
    const capture = captureDbCollectionMethodOptions(db(), 'pages', 'find');
    try {
      await pageLikerSeenUsersToRelations.detect(makeContext());
    } finally {
      capture.restore();
    }
    const [, options] = capture.calls[0] as [unknown, { readPreference?: string }];
    expect(options?.readPreference).toBe('primary');
  });
});

describe('AC-5: field-level normalization stats (D-5 / C-VALIDATION)', () => {
  it('reports per-field normalization totals; a scalar valid ObjectId counts in nonArrayLegacyFields, not droppedElements', async () => {
    const keep = oid();
    const seenScalar = oid();
    await insertLegacyPage({ liker: [keep, keep, 'not-a-valid-id', 12345], seenUsers: seenScalar });

    const result = await copyRelationsStage.fn(makeContext());
    expect(result.stats).toMatchObject({
      likesUpserted: 1,
      seensUpserted: 1,
      likeNormalization: { inputElements: 4, droppedElements: 2, deduplicatedElements: 1, nonArrayLegacyFields: 0 },
      seenNormalization: { inputElements: 1, droppedElements: 0, deduplicatedElements: 0, nonArrayLegacyFields: 1 },
    });

    const likes = await likeRows();
    expect(likes).toHaveLength(1);
    expect(likes[0].user.toHexString()).toBe(keep.toHexString());
  });
});

describe('AC-6: verify-relations — inclusion check and the $unset gate', () => {
  it('passes when every copied source key exists in the target', async () => {
    await insertLegacyPage({ liker: [oid()] });
    await copyRelationsStage.fn(makeContext());

    const result = await verifyRelationsStage.fn(makeContext());
    expect(result).toMatchObject({ name: 'verify-relations', transformed: 0, stats: { missingLikes: 0, missingSeens: 0 } });
  });

  it('throws PageRelationMigrationError when the target is missing a source relation, and legacy fields are left in place', async () => {
    await insertLegacyPage({ liker: [oid()] });
    // copy is skipped — verify must see the target as missing this relation.
    await expect(verifyRelationsStage.fn(makeContext())).rejects.toBeInstanceOf(PageRelationMigrationError);
    expect(await db().collection('pages').countDocuments(LEGACY_FIELD_FILTER)).toBe(1);
  });

  it('a stage-3 failure prevents unset-legacy-fields from ever running (via the full apply)', async () => {
    await insertLegacyPage({ liker: [oid()] });
    const forced = new PageRelationMigrationError('forced verify failure', {
      duplicateLikes: 0,
      duplicateSeens: 0,
      missingLikes: 1,
      missingSeens: 0,
      samples: [],
    });
    const verifySpy = jest.spyOn(verifyRelationsStage, 'fn').mockRejectedValueOnce(forced);
    const unsetSpy = jest.spyOn(unsetLegacyFieldsStage, 'fn');
    let unsetCalls: number;
    try {
      await expect(makeRunner().apply(pageLikerSeenUsersToRelations)).rejects.toBe(forced);
      unsetCalls = unsetSpy.mock.calls.length;
    } finally {
      verifySpy.mockRestore();
      unsetSpy.mockRestore();
    }
    expect(unsetCalls).toBe(0);
    expect(await db().collection('pages').countDocuments(LEGACY_FIELD_FILTER)).toBe(1);
  });
});

describe('AC-7: bounded, sanitized, identifiable report (message carries the detail, not just stats)', () => {
  it('a message with >20 combined duplicate samples is capped at 20, with accurate totals and only the 4 allowed fields', async () => {
    await dropCompoundUniqueIndex('likes');
    const groups: { page: Types.ObjectId; user: Types.ObjectId }[] = [];
    for (let i = 0; i < 25; i += 1) {
      groups.push({ page: oid(), user: oid() });
    }
    await db()
      .collection('likes')
      // Two INDEPENDENT documents per group — the driver auto-assigns `_id`
      // in place, so inserting the same object reference twice collides on
      // `_id` (not the `{page,user}` we're actually trying to duplicate).
      .insertMany(
        groups.flatMap((g) => [
          { ...g, createdAt: null },
          { ...g, createdAt: null },
        ]),
      );

    // The raw driver error deliberately carries forbidden content (a page
    // path, a title, a body snippet, driver-internal jargon) so the
    // not-present assertions below are meaningful — they prove sanitization
    // actually stripped something that was there, not that it was never
    // present to begin with.
    const original = new Error(
      'index build failed, no code — errmsg: "E11000 duplicate key error collection: crowidb.likes index: page_1_user_1_unique dup key" ' +
        'path=/__cutover/should-not-leak title="Confidential Page Title" body="secret body text" codeName=DuplicateKey',
    );
    const Like = crowi.model('Like');
    const ensureSpy = jest.spyOn(Like, 'ensureUniqueIndex').mockRejectedValueOnce(original);
    try {
      await prepareTargetIndexStage.fn(makeContext());
      throw new Error('expected a rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(PageRelationMigrationError);
      const e = err as PageRelationMigrationError;
      expect(e.stats.duplicateLikes).toBe(25);
      expect(e.stats.samples).toHaveLength(20);
      expect(e.message).toContain('duplicateLikes=25');
      // `$group` does not guarantee output order, so no single sample's
      // identity is pinned to a specific input index — instead, every
      // returned sample must (a) actually appear in `message` itself, not
      // just in `stats`, and (b) trace back to one of the seeded groups
      // (proving the ids are real seeded data, not fabricated).
      const seededPairs = new Set(groups.map((g) => `${g.page.toHexString()}:${g.user.toHexString()}`));
      for (const sample of e.stats.samples) {
        expect(e.message).toContain(`page=${sample.pageId} user=${sample.userId}`);
        expect(seededPairs.has(`${sample.pageId}:${sample.userId}`)).toBe(true);
      }
      // Only kind / page / user / count ever appear — the raw driver error's
      // path / title / body / internal jargon never leaks into the sanitized message.
      expect(e.message).not.toContain('/__cutover');
      expect(e.message).not.toContain('should-not-leak');
      expect(e.message).not.toContain('Confidential Page Title');
      expect(e.message).not.toContain('secret body text');
      expect(e.message).not.toMatch(/errmsg|codeName|writeConcern|DuplicateKey/);
      const sampleLines = e.message.split('Samples')[1];
      expect((sampleLines.match(/duplicate-like/g) ?? []).length).toBe(20);
    } finally {
      ensureSpy.mockRestore();
    }
  });
});

describe('AC-8: re-run / partial-unset convergence (C-CONCURRENCY)', () => {
  it('a full apply followed by a second (now-clean) apply is a no-op consistent re-check and creates no duplicate relation rows', async () => {
    await insertLegacyPage({ liker: [oid()] });
    const first = await makeRunner().apply(pageLikerSeenUsersToRelations);
    expect(first.result).toBe('applied');
    expect(await pageLikerSeenUsersToRelations.isPending(makeContext())).toBe(false);

    // §6.2 "not pending + already applied" reconciliation: a consistent
    // no-op, not a fresh `detected-clean` (that label is reserved for a
    // never-applied, already-clean install — runner.ts `apply()`).
    const second = await makeRunner().apply(pageLikerSeenUsersToRelations);
    expect(second.result).toBe('applied');
    expect(await MigrationApplication().countDocuments({ migrationId: pageLikerSeenUsersToRelations.id })).toBe(1);
    expect(await likeRows()).toHaveLength(1);
  });

  it('re-running copy+verify after a simulated interruption (stage 4 never reached) does not duplicate rows', async () => {
    const user = oid();
    await insertLegacyPage({ liker: [user] });

    // Simulate an interrupted run: stages 1-3 ran, the process died before stage 4.
    await prepareTargetIndexStage.fn(makeContext());
    await copyRelationsStage.fn(makeContext());
    await verifyRelationsStage.fn(makeContext());
    expect(await db().collection('pages').countDocuments(LEGACY_FIELD_FILTER)).toBe(1);

    // Resume: a fresh `apply()` re-runs the whole stage list from scratch.
    const outcome = await makeRunner().apply(pageLikerSeenUsersToRelations);
    expect(outcome.result).toBe('applied');
    const likes = await likeRows();
    expect(likes).toHaveLength(1);
    expect(likes[0].user.toHexString()).toBe(user.toHexString());
    expect(await db().collection('pages').countDocuments(LEGACY_FIELD_FILTER)).toBe(0);
  });

  it('a partial unset (some legacy pages still unset) stays pending and converges on the next apply', async () => {
    const pageA = await insertLegacyPage({ liker: [oid()] });
    const pageB = await insertLegacyPage({ liker: [oid()] });
    await copyRelationsStage.fn(makeContext());
    await verifyRelationsStage.fn(makeContext());

    // Simulate an interrupted unset: only pageA's legacy fields are removed.
    await db()
      .collection('pages')
      .updateOne({ _id: pageA }, { $unset: { liker: '' } });
    expect(await pageLikerSeenUsersToRelations.isPending(makeContext())).toBe(true);
    expect(await db().collection('pages').findOne({ _id: pageB })).not.toBeNull();

    const outcome = await makeRunner().apply(pageLikerSeenUsersToRelations);
    expect(outcome.result).toBe('applied');
    expect(await pageLikerSeenUsersToRelations.isPending(makeContext())).toBe(false);
    expect(await likeRows()).toHaveLength(2);
  });
});

describe('AC-9: boot integration through registry fixtures (block/warn, --id semantics)', () => {
  it('refuses boot under block while pending, and boots clean once applied', async () => {
    await insertLegacyPage({ liker: [oid()] });
    const registry = new MigrationRegistry([pageLikerSeenUsersToRelations]);

    await expect(runBootMigrations(crowi, { registry, policy: 'block' })).rejects.toBeInstanceOf(PreflightBlockedError);

    await makeRunner().apply(pageLikerSeenUsersToRelations);
    const result = await runBootMigrations(crowi, { registry, policy: 'block' });
    expect(result.pendingBlockingIds).toEqual([]);
  });

  it('warns and continues under warn while pending', async () => {
    await insertLegacyPage({ seenUsers: [oid()] });
    const registry = new MigrationRegistry([pageLikerSeenUsersToRelations]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await runBootMigrations(crowi, { registry, policy: 'warn' });
      expect(result.pendingBlockingIds).toEqual(['page-liker-seenusers-to-relations']);
    } finally {
      warn.mockRestore();
    }
  });

  it('a target-only apply --id leaves a co-pending blocking migration still refusing boot', async () => {
    await insertLegacyPage({ liker: [oid()] });
    const other = defineMigration({
      id: 'frt-other-blocking',
      fromVersion: '1.x',
      toVersion: '2.0',
      layer: 'preflight',
      severity: 'blocking',
      description: 'fixture always-pending blocking migration',
      isPending: async () => true,
      stages: [],
    });
    const registry = new MigrationRegistry([pageLikerSeenUsersToRelations, other]);

    await makeRunner().apply(pageLikerSeenUsersToRelations);

    await expect(runBootMigrations(crowi, { registry, policy: 'block' })).rejects.toMatchObject({ pendingIds: ['frt-other-blocking'] });
  });

  it('an --id-less apply (MigrationCliApi.apply({})) sweeps in a pending cosmetic migration too — the runbook basis for requiring --id', async () => {
    await insertLegacyPage({ liker: [oid()] });
    const cosmetic = defineMigration({
      id: 'frt-cosmetic-fixture',
      fromVersion: '1.x',
      toVersion: '2.0',
      layer: 'preflight',
      severity: 'cosmetic',
      description: 'fixture always-pending cosmetic migration',
      isPending: async () => true,
      stages: [{ name: 'noop', fn: async () => ({ name: 'noop', transformed: 0 }) }],
    });
    const registry = new MigrationRegistry([pageLikerSeenUsersToRelations, cosmetic]);
    const api = new MigrationCliApi(crowi, registry);

    const outcomes = await api.apply({});
    const ids = outcomes.map((o) => o.id);
    expect(ids).toContain(pageLikerSeenUsersToRelations.id);
    expect(ids).toContain('frt-cosmetic-fixture');
  });
});

describe('AC-11: coexists as the second blocking migration', () => {
  it('is blocking and the default registry now has exactly 2 blocking preflight migrations', () => {
    expect(pageLikerSeenUsersToRelations.severity).toBe('blocking');
    const blockingIds = createRegistry()
      .byLayer('preflight')
      .filter((m) => m.severity === 'blocking')
      .map((m) => m.id);
    expect(blockingIds.sort()).toEqual(['page-liker-seenusers-to-relations', 'user-unique-prepare']);
  });
});

describe('AC-14: C-COMPAT count correction is one compatibility change; scalar-stored valid ids are unaffected', () => {
  it('a corrupted array under-counts relative to raw length, while a scalar-stored valid id still counts as exactly 1', async () => {
    const kept = oid();
    const pageA = await insertLegacyPage({ liker: [kept, kept, 'garbage', null] }); // raw length 4, corrected count 1
    const scalarValid = oid();
    const pageB = await insertLegacyPage({ liker: scalarValid }); // scalar, valid — unaffected by the correction

    await copyRelationsStage.fn(makeContext());

    const likes = await likeRows();
    const forA = likes.filter((r) => r.page.toHexString() === pageA.toHexString());
    const forB = likes.filter((r) => r.page.toHexString() === pageB.toHexString());
    expect(forA).toHaveLength(1); // corrected down from a raw array length of 4
    expect(forB).toHaveLength(1); // unchanged — matches today's visible likerCount of 1
  });
});

describe('AC-16: C-PERF query shape', () => {
  it('copy issues no bulkWrite for a collection with no ops (2 pages, Like only)', async () => {
    await insertLegacyPage({ liker: [oid()] });
    await insertLegacyPage({ liker: [oid()] });

    const Like = crowi.model('Like');
    const Seen = crowi.model('Seen');
    const likeBulkSpy = jest.spyOn(Like.collection, 'bulkWrite');
    const seenBulkSpy = jest.spyOn(Seen.collection, 'bulkWrite');
    let likeCalls: number;
    let seenCalls: number;
    try {
      await copyRelationsStage.fn(makeContext());
      likeCalls = likeBulkSpy.mock.calls.length;
      seenCalls = seenBulkSpy.mock.calls.length;
    } finally {
      likeBulkSpy.mockRestore();
      seenBulkSpy.mockRestore();
    }
    // 2 pages fit in a single 500-page batch -> exactly one bulkWrite call
    // for the (non-empty) Like ops, and none for Seen (no seenUsers seeded).
    expect(likeCalls).toBe(1);
    expect(seenCalls).toBe(0);
  });

  it('copy issues exactly one bulkWrite per PAGE_BATCH_SIZE page-batch, not one per page (PAGE_BATCH_SIZE+1 pages -> 2 calls)', async () => {
    const docs = Array.from({ length: PAGE_BATCH_SIZE + 1 }, () => {
      const _id = oid();
      return { _id, path: `/__cutover/${_id.toHexString()}`, liker: [oid()] };
    });
    await db().collection('pages').insertMany(docs);

    const Like = crowi.model('Like');
    const likeBulkSpy = jest.spyOn(Like.collection, 'bulkWrite');
    let likeCalls: number;
    try {
      const result = await copyRelationsStage.fn(makeContext());
      likeCalls = likeBulkSpy.mock.calls.length;
      expect(result.stats).toMatchObject({ pagesScanned: PAGE_BATCH_SIZE + 1, likesUpserted: PAGE_BATCH_SIZE + 1 });
    } finally {
      likeBulkSpy.mockRestore();
    }
    expect(likeCalls).toBe(2);
  });

  it('copy never reads the target before writing (cross-referenced with AC-4)', async () => {
    await insertLegacyPage({ liker: [oid()] });
    const Like = crowi.model('Like');
    const findSpy = jest.spyOn(Like.collection, 'find');
    let calls: number;
    try {
      await copyRelationsStage.fn(makeContext());
      calls = findSpy.mock.calls.length;
    } finally {
      findSpy.mockRestore();
    }
    expect(calls).toBe(0);
  });

  it('verify issues one $in-batched find per collection per page-batch, not per page, with an index-backed {page:{$in:...}} filter and a page/user-only projection', async () => {
    const pageA = await insertLegacyPage({ liker: [oid()] });
    const pageB = await insertLegacyPage({ liker: [oid()] });
    await copyRelationsStage.fn(makeContext());

    const Like = crowi.model('Like');
    const Seen = crowi.model('Seen');
    const likeFindSpy = jest.spyOn(Like.collection, 'find');
    const seenFindSpy = jest.spyOn(Seen.collection, 'find');
    let likeCallArgs: unknown[] | undefined;
    let seenCallArgs: unknown[] | undefined;
    let likeCalls: number;
    let seenCalls: number;
    try {
      await verifyRelationsStage.fn(makeContext());
      likeCalls = likeFindSpy.mock.calls.length;
      seenCalls = seenFindSpy.mock.calls.length;
      likeCallArgs = likeFindSpy.mock.calls[0];
      seenCallArgs = seenFindSpy.mock.calls[0];
    } finally {
      likeFindSpy.mockRestore();
      seenFindSpy.mockRestore();
    }
    expect(likeCalls).toBe(1);
    expect(seenCalls).toBe(1);

    const [likeFilter, likeOptions] = likeCallArgs as [{ page?: { $in: unknown[] } }, { projection?: unknown; readPreference?: string }];
    expect(likeFilter.page?.$in).toBeDefined();
    expect((likeFilter.page?.$in as Types.ObjectId[]).map((id) => id.toHexString()).sort()).toEqual([pageA.toHexString(), pageB.toHexString()].sort());
    expect(likeOptions.projection).toEqual({ page: 1, user: 1 });
    expect(likeOptions.readPreference).toBe('primary');

    const [seenFilter, seenOptions] = seenCallArgs as [{ page?: { $in: unknown[] } }, { projection?: unknown; readPreference?: string }];
    expect(seenFilter.page?.$in).toBeDefined();
    expect((seenFilter.page?.$in as Types.ObjectId[]).map((id) => id.toHexString()).sort()).toEqual([pageA.toHexString(), pageB.toHexString()].sort());
    expect(seenOptions.projection).toEqual({ page: 1, user: 1 });
    expect(seenOptions.readPreference).toBe('primary');
  });

  it('verify issues exactly one $in-batched find per collection per page-batch (PAGE_BATCH_SIZE+1 pages -> 2 calls), each scoped to that batch by an index-backed {page:{$in:...}} filter', async () => {
    const docs = Array.from({ length: PAGE_BATCH_SIZE + 1 }, () => {
      const _id = oid();
      return { _id, path: `/__cutover/${_id.toHexString()}`, liker: [oid()] };
    });
    await db().collection('pages').insertMany(docs);
    await copyRelationsStage.fn(makeContext());

    const Like = crowi.model('Like');
    const likeFindSpy = jest.spyOn(Like.collection, 'find');
    let likeCalls: number;
    let callArgs: unknown[][];
    try {
      const result = await verifyRelationsStage.fn(makeContext());
      likeCalls = likeFindSpy.mock.calls.length;
      callArgs = likeFindSpy.mock.calls;
      expect(result.stats).toMatchObject({ pagesVerified: PAGE_BATCH_SIZE + 1, missingLikes: 0 });
    } finally {
      likeFindSpy.mockRestore();
    }
    expect(likeCalls).toBe(2);
    const [firstFilter, firstOptions] = callArgs[0] as [{ page?: { $in: unknown[] } }, { projection?: unknown }];
    const [secondFilter] = callArgs[1] as [{ page?: { $in: unknown[] } }];
    // A full-collection find({}) once per batch would also pass a bare call-count
    // assertion — the batch-sized $in length is what actually proves the
    // index-backed shape (not a collection scan).
    expect((firstFilter.page?.$in as unknown[]).length).toBe(PAGE_BATCH_SIZE);
    expect((secondFilter.page?.$in as unknown[]).length).toBe(1);
    expect(firstOptions.projection).toEqual({ page: 1, user: 1 });
  });
});
