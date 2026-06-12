/**
 * feature-user-identity-uniqueness §c / §e — minimal user merge + reference
 * reassign, used by the `user-unique-prepare` preflight migration to resolve
 * existing duplicate users before the plain unique indexes are built.
 *
 * This is the *minimal* merge (uniqueness spec §2 "案2A"): just enough to
 * reassign every ownership reference from a losing duplicate onto the surviving
 * one and delete the loser. The full operator-facing `crowi-admin user merge`
 * tool (uniqueness spec §e) is a separate task and not built here, but the
 * reference-reassign set is the same so this routine is the shared core.
 *
 * The reassign set is the full collection/field set that had to be fixed by
 * hand during the 2026-05 incident (uniqueness spec §c):
 *
 *   pages.creator, pages.lastUpdateUser                       (scalar)
 *   pages.grantedUsers[], pages.liker[], pages.seenUsers[]    (array)
 *   revisions.author, revisions.savedBy                       (scalar)
 *   revisions.contributors[]                                  (array)
 *   comments.creator, bookmarks.user, attachments.creator,
 *   shares.creator, watchers.user, activities.user,
 *   notifications.user, updateposts.creator                  (scalar)
 *
 * Array fields use `$addToSet(to)` then `$pull(from)` so the surviving id
 * appears at most once. `bookmarks` carries a unique `{ page, user }` index, so
 * a losing user's bookmark of a page the survivor already bookmarked would
 * collide on reassign — those losing rows are deleted first.
 *
 * Operations run on the raw mongo driver (`db.collection(...)`) rather than
 * Mongoose models so this works uniformly across every collection (some of
 * which aren't registered as models in every context) and stays close to the
 * shape a future PostgreSQL port would take.
 */
import type { mongo } from 'mongoose';

import type { MigrationLogger } from 'src/migration/types';

type Db = mongo.Db;
type ObjectId = mongo.ObjectId;

/** A scalar (`$set`) reference: one field on one collection holding a single user id. */
interface ScalarRef {
  collection: string;
  field: string;
}

/** An array (`$addToSet`/`$pull`) reference: a field holding a list of user ids. */
interface ArrayRef {
  collection: string;
  field: string;
}

/**
 * The full scalar reference set (uniqueness spec §c). `from` is matched by
 * exact equality; reassigned to `to` via `$set`.
 */
export const SCALAR_USER_REFS: readonly ScalarRef[] = [
  { collection: 'pages', field: 'creator' },
  { collection: 'pages', field: 'lastUpdateUser' },
  { collection: 'revisions', field: 'author' },
  { collection: 'revisions', field: 'savedBy' },
  { collection: 'comments', field: 'creator' },
  // `bookmarks.user`: the compound-unique conflict (a page both users
  // bookmarked) is resolved first by UNIQUE_PER_USER_REFS below; the remaining
  // non-conflicting rows reassign here like any other scalar.
  { collection: 'bookmarks', field: 'user' },
  { collection: 'attachments', field: 'creator' },
  { collection: 'shares', field: 'creator' },
  { collection: 'watchers', field: 'user' },
  { collection: 'activities', field: 'user' },
  { collection: 'notifications', field: 'user' },
  { collection: 'updateposts', field: 'creator' },
];

/** The full array reference set (uniqueness spec §c). */
export const ARRAY_USER_REFS: readonly ArrayRef[] = [
  { collection: 'pages', field: 'grantedUsers' },
  { collection: 'pages', field: 'liker' },
  { collection: 'pages', field: 'seenUsers' },
  { collection: 'revisions', field: 'contributors' },
];

/**
 * Collections with a unique `{ <pageField>, user }` index where reassigning a
 * losing user's row onto the survivor could collide with an existing survivor
 * row. Those losing rows are deleted before the generic scalar reassign so the
 * `$set` never trips the compound unique index. `bookmarks` is the only such
 * collection in the §c set.
 */
const UNIQUE_PER_USER_REFS: readonly { collection: string; userField: string }[] = [{ collection: 'bookmarks', userField: 'user' }];

export interface ReassignResult {
  /** Per-collection.field count of documents updated (scalar + array). */
  reassigned: Record<string, number>;
  /** Rows deleted to avoid a compound-unique collision (e.g. duplicate bookmarks). */
  deletedConflicting: number;
}

/**
 * Reassign every ownership reference from `from` to `to`. Does not touch the
 * `users` collection itself (the caller deletes/keeps the user docs). Pure data
 * movement — safe to call repeatedly (idempotent: a second run finds no `from`
 * references left).
 */
export async function reassignUserReferences(db: Db, from: ObjectId, to: ObjectId, logger?: MigrationLogger): Promise<ReassignResult> {
  const reassigned: Record<string, number> = {};
  let deletedConflicting = 0;

  // 1. Resolve compound-unique collisions first (delete losing rows that would
  //    collide with an existing survivor row on reassign). For bookmarks the
  //    unique key is { page, user }: delete a `from` bookmark whose page the
  //    `to` user already bookmarks.
  for (const { collection, userField } of UNIQUE_PER_USER_REFS) {
    const col = db.collection(collection);
    const fromRows = await col.find({ [userField]: from }).toArray();
    for (const row of fromRows) {
      const page = (row as Record<string, unknown>).page;
      const survivorHas = await col.findOne({ page, [userField]: to });
      if (survivorHas) {
        await col.deleteOne({ _id: (row as { _id: unknown })._id } as Record<string, unknown>);
        deletedConflicting += 1;
      }
    }
  }

  // 2. Scalar references: `$set` field = to where field = from.
  for (const { collection, field } of SCALAR_USER_REFS) {
    const res = await db.collection(collection).updateMany({ [field]: from }, { $set: { [field]: to } });
    const n = res.modifiedCount ?? 0;
    if (n > 0) reassigned[`${collection}.${field}`] = n;
  }

  // 3. Array references: add the survivor, then remove the loser. `$addToSet`
  //    keeps the survivor unique; doing it before `$pull` means a doc that had
  //    only `from` still ends up with `to`.
  for (const { collection, field } of ARRAY_USER_REFS) {
    const col = db.collection(collection);
    const added = await col.updateMany({ [field]: from }, { $addToSet: { [field]: to } });
    const pulled = await col.updateMany({ [field]: from }, { $pull: { [field]: from } } as Record<string, unknown>);
    const n = Math.max(added.modifiedCount ?? 0, pulled.modifiedCount ?? 0);
    if (n > 0) reassigned[`${collection}.${field}`] = n;
  }

  logger?.debug(`reassignUserReferences: ${from} -> ${to}`, reassigned, { deletedConflicting });
  return { reassigned, deletedConflicting };
}

/** A single duplicate group: the user kept plus the users merged away. */
export interface MergeGroup {
  keep: ObjectId;
  remove: ObjectId[];
}

export interface DedupResult {
  groupsMerged: number;
  usersRemoved: number;
  reassigned: Record<string, number>;
  deletedConflicting: number;
}

/**
 * Merge each group: reassign every removed user's references onto `keep`, then
 * delete the removed user docs. `dryRun` reports the would-be effect without
 * writing.
 */
export async function mergeUserGroups(db: Db, groups: readonly MergeGroup[], opts: { dryRun: boolean; logger?: MigrationLogger }): Promise<DedupResult> {
  const reassigned: Record<string, number> = {};
  let usersRemoved = 0;
  let deletedConflicting = 0;
  let groupsMerged = 0;

  for (const group of groups) {
    if (group.remove.length === 0) continue;
    groupsMerged += 1;
    if (opts.dryRun) {
      usersRemoved += group.remove.length;
      continue;
    }
    for (const from of group.remove) {
      const result = await reassignUserReferences(db, from, group.keep, opts.logger);
      for (const [key, n] of Object.entries(result.reassigned)) {
        reassigned[key] = (reassigned[key] ?? 0) + n;
      }
      deletedConflicting += result.deletedConflicting;
      await db.collection('users').deleteOne({ _id: from } as Record<string, unknown>);
      usersRemoved += 1;
    }
  }

  return { groupsMerged, usersRemoved, reassigned, deletedConflicting };
}

/**
 * The policy for choosing which user in a duplicate group survives
 * (uniqueness spec §c): keep the one with the most content, breaking ties by
 * oldest `createdAt`. "Content" is approximated by the number of pages the user
 * created — the dominant signal in the incident and cheap to count.
 *
 * Returns the group with `keep` set to the winner and `remove` to the rest.
 */
export async function chooseSurvivor(db: Db, candidateIds: readonly ObjectId[]): Promise<MergeGroup> {
  if (candidateIds.length === 0) throw new Error('chooseSurvivor: empty candidate set');

  const users = await db
    .collection('users')
    .find({ _id: { $in: candidateIds as ObjectId[] } })
    .toArray();
  const pages = db.collection('pages');

  const scored = await Promise.all(
    users.map(async (u) => {
      const id = (u as { _id: ObjectId })._id;
      const createdAt = (u as { createdAt?: Date }).createdAt ?? new Date(0);
      const pageCount = await pages.countDocuments({ creator: id });
      return { id, createdAt, pageCount };
    }),
  );

  scored.sort((a, b) => {
    if (b.pageCount !== a.pageCount) return b.pageCount - a.pageCount; // most content first
    return a.createdAt.getTime() - b.createdAt.getTime(); // then oldest first
  });

  const [winner, ...losers] = scored;
  return { keep: winner.id, remove: losers.map((l) => l.id) };
}
