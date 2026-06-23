import type { MigrationContext } from './types';

/**
 * Resolve the user id to credit a preflight migration's body rewrites to:
 *   1. `CROWI_MIGRATE_USER=<email>` if set,
 *   2. otherwise the oldest admin (`{ admin: true }` by `createdAt`).
 *
 * Throws with `migrationName` in the message when neither yields a user, so the
 * operator sees which migration tripped instead of a per-page `user should have
 * _id` failure deep inside the rewrite. Used by every preflight migration that
 * pushes new revisions on the operator's behalf (`wikilink-format`,
 * `files-url-to-attachments`, …).
 */
export async function resolveActingUserId(ctx: MigrationContext, migrationName: string): Promise<string> {
  const User = ctx.crowi.model('User');
  const explicit = process.env.CROWI_MIGRATE_USER;
  if (explicit) {
    const named = await User.findOne({ email: explicit }).select('_id').lean().exec();
    if (named) return String((named as { _id: unknown })._id);
    throw new Error(`CROWI_MIGRATE_USER='${explicit}' but no user with that email exists.`);
  }
  const admin = await User.findOne({ admin: true }).sort({ createdAt: 1 }).select('_id').lean().exec();
  if (admin) return String((admin as { _id: unknown })._id);
  throw new Error(`${migrationName}: no admin user found; set CROWI_MIGRATE_USER=<email> or create an admin user first.`);
}
