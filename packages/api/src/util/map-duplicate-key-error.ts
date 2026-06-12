/**
 * feature-user-identity-uniqueness §d — map a MongoDB duplicate-key error
 * (E11000) raised by the `users.username` / `users.email` unique indexes to a
 * caller-facing error code.
 *
 * The unique indexes are the final defence: the write paths pre-check with a
 * `findOne`, but a race between that check and the `save()` can still land two
 * concurrent inserts/updates, in which case the second one fails with E11000.
 * Without this mapping it would surface as a generic 500; with it the handler
 * returns the same `USERNAME_TAKEN` / `EMAIL_TAKEN` it would have returned from
 * the pre-check.
 *
 * Detection prefers `err.keyPattern` (the driver populates it with the index's
 * key spec, e.g. `{ email: 1 }`), falling back to scanning the message for the
 * index/key name when an older driver omits `keyPattern`.
 */
import type { ErrorCode } from '@crowi/api-contract';

/** Mongo duplicate-key errors carry `code === 11000`. */
const DUPLICATE_KEY_CODE = 11000;

type MongoDuplicateKeyError = {
  code?: number;
  keyPattern?: Record<string, unknown>;
  keyValue?: Record<string, unknown>;
  message?: string;
};

const asMongoError = (err: unknown): MongoDuplicateKeyError | null => {
  if (typeof err !== 'object' || err === null) return null;
  return err as MongoDuplicateKeyError;
};

/** True iff `err` is a MongoDB duplicate-key (E11000) error. */
export function isDuplicateKeyError(err: unknown): boolean {
  return asMongoError(err)?.code === DUPLICATE_KEY_CODE;
}

/**
 * Map a duplicate-key error on the user identity indexes to `USERNAME_TAKEN` /
 * `EMAIL_TAKEN`. Returns `null` when `err` is not an E11000 error, or is on a
 * field this util doesn't own (so the caller can fall through to its generic
 * 500 handling rather than mislabel an unrelated conflict).
 */
export function mapDuplicateKeyError(err: unknown): ErrorCode | null {
  const mongoErr = asMongoError(err);
  if (!mongoErr || mongoErr.code !== DUPLICATE_KEY_CODE) return null;

  // Preferred: the driver's structured key spec (`{ email: 1 }` etc.).
  const keys = mongoErr.keyPattern ? Object.keys(mongoErr.keyPattern) : Object.keys(mongoErr.keyValue ?? {});
  if (keys.includes('email')) return 'EMAIL_TAKEN';
  if (keys.includes('username')) return 'USERNAME_TAKEN';

  // Fallback: parse the index name out of the message
  // (`... index: email_1 dup key: ...`).
  const message = mongoErr.message ?? '';
  if (/index:\s*email/i.test(message)) return 'EMAIL_TAKEN';
  if (/index:\s*username/i.test(message)) return 'USERNAME_TAKEN';

  return null;
}
