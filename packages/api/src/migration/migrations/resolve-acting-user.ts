import type { MigrationContext } from '../types';

/**
 * Resolve which user is recorded as the author of every revision a migration
 * rewrites. The `updatePage`-equivalent path (`ctx.rewritePageBody`) ultimately
 * calls `Revision.prepareRevision`, which **throws** when handed a falsy user,
 * so a preflight rewrite MUST resolve a real acting user up front rather than
 * rely on per-page `lastUpdateUser`/`creator` (those can dangle to a deleted
 * user).
 *
 * Order, mirroring the legacy `migrate-wikilink` command:
 *   1. `process.env.CROWI_MIGRATE_USER` — interpreted as an email; the named
 *      user must exist.
 *   2. otherwise the oldest admin user (`{ admin: true }` sorted by createdAt),
 *      deterministic across re-runs.
 *
 * Throws when neither yields a user so the operator gets a clear error instead
 * of a per-page `user should have _id` failure deep inside the rewrite. The
 * `migrationId` is woven into the no-admin error so the message names the
 * migration that needed the user.
 */
export async function resolveActingUserId(ctx: MigrationContext, migrationId: string): Promise<string> {
  const User = ctx.crowi.model('User');
  const explicit = process.env.CROWI_MIGRATE_USER;
  if (explicit) {
    const named = await User.findOne({ email: explicit }).select('_id').lean().exec();
    if (named) return String((named as { _id: unknown })._id);
    throw new Error(`CROWI_MIGRATE_USER='${explicit}' but no user with that email exists.`);
  }
  const admin = await User.findOne({ admin: true }).sort({ createdAt: 1 }).select('_id').lean().exec();
  if (admin) return String((admin as { _id: unknown })._id);
  throw new Error(`${migrationId}: no admin user found; set CROWI_MIGRATE_USER=<email> or create an admin user first.`);
}
