import type { mongo } from 'mongoose';

import { chooseSurvivor, mergeUserGroups } from 'src/util/dedup-users';
import type { MergeGroup } from 'src/util/dedup-users';

import { defineMigration } from '../types';
import type { MigrationContext } from '../types';

/**
 * RFC-0008 §11 / feature-user-identity-uniqueness — `user-unique-prepare`
 * (preflight layer).
 *
 * Prepares the `users` collection so the plain unique indexes on
 * `username` / `email` (declared in `models/user.ts`, built by autoIndex on
 * boot) can build without E11000:
 *
 *   1. `dedup-username` — merge living users that collide on a
 *      case-insensitive username, reassigning every ownership reference to the
 *      survivor (uniqueness spec §c) and deleting the losers.
 *   2. `dedup-email` — same for email.
 *   3. `tombstone-deleted` — rename any STATUS_DELETED user whose original
 *      username/email would collide with a living user (or another deleted
 *      user) to the per-id `deleted-<id>` tombstone, matching the runtime
 *      `statusDelete` behaviour. Without this, a legacy deleted row that kept
 *      its original identity would collide a living user on index build.
 *
 * Index BUILDING is not done here (§9): the schema declares the indexes and
 * Mongoose autoIndex builds them. This migration only prepares the data.
 *
 * `isPending` is conservative (§6.2): it reports pending whenever a residual
 * collision exists that would fail an index build, and once the stages run it
 * flips to false (no permanent boot block — same lesson as Phase 3). The
 * comparison folds case (matching the index collation `{ locale:'en',
 * strength:2 }`) via `$toLower` in the aggregation.
 */

// STATUS_DELETED is `4` (models/user.ts). Re-declared locally rather than
// imported so this migration has no boot-order coupling to the User model
// factory; the value is part of the v1 data contract and does not change.
const STATUS_DELETED = 4;

type ObjectId = mongo.ObjectId;

/**
 * A case-folded duplicate group from the `users` collection. `field` is either
 * the raw stored value; the aggregation groups by its lowercased form.
 */
interface DuplicateGroup {
  /** Lowercased key the rows collide on. */
  key: string;
  /** All user ids sharing the key (living only — DELETED excluded). */
  ids: ObjectId[];
}

/**
 * Find living-user duplicate groups for `field` (`username` | `email`), folding
 * case so `Sotarok` and `sotarok` collide (mirrors the index collation).
 * STATUS_DELETED users are excluded — they are handled by `tombstone-deleted`,
 * not merged. Rows missing the field (e.g. INVITED with no username) are
 * excluded so the sparse index's exempt rows never form a group.
 */
async function findLivingDuplicateGroups(ctx: MigrationContext, field: 'username' | 'email'): Promise<DuplicateGroup[]> {
  const users = ctx.db.collection('users');
  const rows = await users
    .aggregate([
      { $match: { status: { $ne: STATUS_DELETED }, [field]: { $type: 'string', $ne: '' } } },
      { $group: { _id: { $toLower: `$${field}` }, ids: { $push: '$_id' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();
  return rows.map((r) => ({ key: String((r as { _id: unknown })._id), ids: (r as { ids: ObjectId[] }).ids }));
}

/**
 * Find STATUS_DELETED users whose stored username/email is NOT already the
 * tombstone form for their id — i.e. legacy deleted rows that still hold a real
 * identity which could collide a living user on index build. Returns their ids.
 */
async function findUntombstonedDeleted(ctx: MigrationContext): Promise<ObjectId[]> {
  const users = ctx.db.collection('users');
  const rows = await users.find({ status: STATUS_DELETED }).project({ _id: 1, username: 1, email: 1 }).toArray();
  const out: ObjectId[] = [];
  for (const row of rows) {
    const id = (row as { _id: ObjectId })._id;
    const expectedEmail = `deleted-${id.toString()}@deleted.invalid`;
    const expectedUsername = `deleted-${id.toString()}`;
    const email = (row as { email?: string }).email;
    const username = (row as { username?: string }).username;
    if (email !== expectedEmail || (username != null && username !== expectedUsername)) {
      out.push(id);
    }
  }
  return out;
}

/**
 * True iff the not-yet-tombstoned deleted set collides (case-folded) with any
 * living user — the only deleted-side condition that fails an index build. A
 * deleted row whose identity is unique among living + other deleted rows would
 * not fail the build, so we report pending only when a real collision exists
 * (conservative but not over-eager).
 */
async function deletedCollidesWithLiving(ctx: MigrationContext): Promise<boolean> {
  const users = ctx.db.collection('users');
  // For each field, group by lowercased value across ALL users (living +
  // deleted) and look for a group that mixes a deleted row with a living one.
  for (const field of ['email', 'username'] as const) {
    const rows = await users
      .aggregate([
        { $match: { [field]: { $type: 'string', $ne: '' } } },
        {
          $group: {
            _id: { $toLower: `$${field}` },
            living: { $sum: { $cond: [{ $ne: ['$status', STATUS_DELETED] }, 1, 0] } },
            deleted: { $sum: { $cond: [{ $eq: ['$status', STATUS_DELETED] }, 1, 0] } },
          },
        },
        { $match: { living: { $gte: 1 }, deleted: { $gte: 1 } } },
        { $limit: 1 },
      ])
      .toArray();
    if (rows.length > 0) return true;
  }
  return false;
}

export const userUniquePrepare = defineMigration({
  id: 'user-unique-prepare',
  fromVersion: '1.x',
  toVersion: '2.0',
  layer: 'preflight',
  // The ONLY blocking migration: dedups so the unique index can build without
  // E11000 (RFC §9/§11). Booting unapplied risks an autoIndex failure, so a
  // pending verdict must refuse boot under the `block` policy. Do NOT
  // reclassify to cosmetic — that would re-expose E11000.
  severity: 'blocking',
  description: 'Deduplicate users (unique index via autoIndex)',

  /**
   * Pending iff a plain unique index build would fail E11000. Two residual
   * conditions (both folded to the index collation):
   *
   *   - a living-vs-living duplicate on username or email, or
   *   - a not-yet-tombstoned DELETED user colliding with a living user.
   *
   * Conservative (§6.2): once `dedup-*` + `tombstone-deleted` run, every group
   * is resolved and this returns false, so boot under preflight+block clears
   * (no permanent block). Short-circuits at the first collision found.
   */
  isPending: async (ctx) => {
    const usernameDupes = await findLivingDuplicateGroups(ctx, 'username');
    if (usernameDupes.length > 0) return true;
    const emailDupes = await findLivingDuplicateGroups(ctx, 'email');
    if (emailDupes.length > 0) return true;
    return deletedCollidesWithLiving(ctx);
  },

  /** Full-scan report for `plan`: duplicate group counts + tombstone targets. */
  detect: async (ctx) => {
    const usernameDupes = await findLivingDuplicateGroups(ctx, 'username');
    const emailDupes = await findLivingDuplicateGroups(ctx, 'email');
    const tombstoneTargets = await findUntombstonedDeleted(ctx);
    return {
      summary: `${usernameDupes.length} duplicate username group(s), ${emailDupes.length} duplicate email group(s), ${tombstoneTargets.length} deleted user(s) to tombstone`,
      counts: {
        usernameGroups: usernameDupes.length,
        emailGroups: emailDupes.length,
        tombstoneTargets: tombstoneTargets.length,
      },
    };
  },

  stages: [
    {
      name: 'dedup-username',
      fn: async (ctx) => {
        const groups = await findLivingDuplicateGroups(ctx, 'username');
        const mergeGroups: MergeGroup[] = [];
        for (const group of groups) {
          mergeGroups.push(await chooseSurvivor(ctx.db, group.ids));
        }
        ctx.progress.setTotal(mergeGroups.length);
        const result = await mergeUserGroups(ctx.db, mergeGroups, { dryRun: ctx.dryRun, logger: ctx.logger });
        if (!ctx.dryRun && result.usersRemoved > 0) {
          ctx.logger.info(`user-unique-prepare: merged ${result.usersRemoved} duplicate-username user(s) across ${result.groupsMerged} group(s)`);
        }
        return {
          name: 'dedup-username',
          transformed: result.usersRemoved,
          stats: { groups: result.groupsMerged, reassigned: result.reassigned, deletedConflicting: result.deletedConflicting },
        };
      },
    },
    {
      name: 'dedup-email',
      fn: async (ctx) => {
        const groups = await findLivingDuplicateGroups(ctx, 'email');
        const mergeGroups: MergeGroup[] = [];
        for (const group of groups) {
          mergeGroups.push(await chooseSurvivor(ctx.db, group.ids));
        }
        ctx.progress.setTotal(mergeGroups.length);
        const result = await mergeUserGroups(ctx.db, mergeGroups, { dryRun: ctx.dryRun, logger: ctx.logger });
        if (!ctx.dryRun && result.usersRemoved > 0) {
          ctx.logger.info(`user-unique-prepare: merged ${result.usersRemoved} duplicate-email user(s) across ${result.groupsMerged} group(s)`);
        }
        return {
          name: 'dedup-email',
          transformed: result.usersRemoved,
          stats: { groups: result.groupsMerged, reassigned: result.reassigned, deletedConflicting: result.deletedConflicting },
        };
      },
    },
    {
      name: 'tombstone-deleted',
      fn: async (ctx) => {
        const targets = await findUntombstonedDeleted(ctx);
        if (ctx.dryRun) {
          return { name: 'tombstone-deleted', transformed: 0, stats: { wouldTombstone: targets.length } };
        }
        const users = ctx.db.collection('users');
        ctx.progress.setTotal(targets.length);
        let tombstoned = 0;
        for (const id of targets) {
          // Same tombstone shape as runtime statusDelete / tombstoneIdentity.
          await users.updateOne({ _id: id } as Record<string, unknown>, {
            $set: { username: `deleted-${id.toString()}`, email: `deleted-${id.toString()}@deleted.invalid` },
          });
          tombstoned += 1;
          ctx.progress.increment();
        }
        if (tombstoned > 0) {
          ctx.logger.info(`user-unique-prepare: tombstoned ${tombstoned} legacy deleted user(s)`);
        }
        return { name: 'tombstone-deleted', transformed: tombstoned };
      },
    },
  ],
});
