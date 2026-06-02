import crypto from 'node:crypto';

import Debug from 'debug';
import { Document, Model, Schema, Types, model } from 'mongoose';

import Crowi from 'src/crowi';

/**
 * RFC-0010 §Token model — Personal Access Token (PAT).
 *
 * A PAT is an opaque `crowi_pat_…` secret a user issues from the settings
 * UI to drive the API from scripts / CLI. Only the SHA-256 **hash** of the
 * secret is stored — the plaintext is shown once at creation and never
 * persisted. Authentication looks the row up by hash (see
 * `createJwtAuth`'s PAT branch), so the token itself is never recoverable
 * from the database (unlike the legacy `User.apiToken`, which was stored
 * as a recoverable value).
 *
 * Lifetime: `expiresAt = null` means non-expiring; `revokedAt` (set by
 * `DELETE /me/access-tokens/:id`) hard-disables the token. `findActiveByHash`
 * filters both out at query time so revocation / expiry take effect on the
 * very next request (PATs are looked up per-request, no caching).
 */
const PAT_PREFIX = 'crowi_pat_';
const PAT_RANDOM_BYTES = 32;

export interface PersonalAccessTokenDocument extends Document {
  _id: Types.ObjectId;
  tokenHash: string;
  userId: Types.ObjectId;
  name: string;
  scopes: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;

  touchLastUsed(): Promise<void>;
}

export interface PersonalAccessTokenModel extends Model<PersonalAccessTokenDocument> {
  /** Generate a fresh `crowi_pat_…` plaintext + its SHA-256 hash. */
  generateToken(): { token: string; tokenHash: string };
  /** SHA-256-hex of an opaque token (the form stored in `tokenHash`). */
  hashToken(token: string): string;
  /** Active (= not revoked, not expired) token matching `tokenHash`, or null. */
  findActiveByHash(tokenHash: string): Promise<PersonalAccessTokenDocument | null>;
  /** A user's non-revoked tokens, newest first. */
  listByUser(userId: Types.ObjectId): Promise<PersonalAccessTokenDocument[]>;

  TOKEN_PREFIX: string;
}

export default (crowi: Crowi) => {
  const debug = Debug('crowi:models:personal-access-token');

  const schema = new Schema<PersonalAccessTokenDocument, PersonalAccessTokenModel>({
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
    },
    scopes: {
      type: [String],
      required: true,
      default: [],
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
  });

  schema.statics.hashToken = function (token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  };

  schema.statics.generateToken = function (): { token: string; tokenHash: string } {
    const token = `${PAT_PREFIX}${crypto.randomBytes(PAT_RANDOM_BYTES).toString('base64url')}`;
    const tokenHash = PersonalAccessToken.hashToken(token);
    return { token, tokenHash };
  };

  schema.statics.findActiveByHash = function (tokenHash: string): Promise<PersonalAccessTokenDocument | null> {
    const now = new Date();
    return PersonalAccessToken.findOne({
      tokenHash,
      revokedAt: null,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    }).exec();
  };

  schema.statics.listByUser = function (userId: Types.ObjectId): Promise<PersonalAccessTokenDocument[]> {
    // Revoked tokens are hidden — `DELETE /me/access-tokens/:id` revokes
    // (soft-delete), and the public metadata carries no `revokedAt`, so a
    // listed revoked token would be indistinguishable from a live one.
    // Expired tokens stay visible (their past `expiresAt` is surfaced, so
    // the user can see why they no longer work and prune them).
    return PersonalAccessToken.find({ userId, revokedAt: null }).sort({ createdAt: -1 }).exec();
  };

  schema.methods.touchLastUsed = async function (this: PersonalAccessTokenDocument): Promise<void> {
    // Lightweight, non-blocking-ish update on the hot auth path: failures
    // are swallowed so a transient write error never blocks a request the
    // token is otherwise allowed to make (RFC-0010, PHASE2-Q5).
    try {
      await PersonalAccessToken.updateOne({ _id: this._id }, { lastUsedAt: new Date() }).exec();
    } catch (err) {
      debug('touchLastUsed failed (ignored):', err);
    }
  };

  const PersonalAccessToken = model<PersonalAccessTokenDocument, PersonalAccessTokenModel>('PersonalAccessToken', schema);

  PersonalAccessToken.TOKEN_PREFIX = PAT_PREFIX;

  return PersonalAccessToken;
};
