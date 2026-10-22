import crypto from 'node:crypto';

import { Document, Model, Schema, Types, model } from 'mongoose';

import Crowi from 'src/crowi';

/**
 * RFC-0010 §Mongoose models — OAuth 2.0 refresh token with rotation +
 * reuse detection.
 *
 * `POST /oauth/token` issues a refresh token alongside every access token.
 * On each refresh the old token is **rotated**: it is revoked (`revokedAt`
 * set) and its `rotatedTo` is stamped with the successor's hash, then a
 * fresh token is issued. This makes refresh tokens single-use.
 *
 * Reuse detection (RFC-0010 §Security, PHASE3-Q5): if a *revoked* refresh
 * token is presented again — the hallmark of a stolen-token replay — the
 * whole sign-in family is revoked via `revokeFamily`. Every row minted from
 * one sign-in shares an immutable `familyId`, so revocation never walks the
 * `rotatedTo` links. Both the attacker's and the legitimate client's tokens
 * die, forcing a fresh authorization.
 *
 * Only the SHA-256 hash of the opaque `crowi_rt_…` secret is stored; the
 * `crowi_rt_` prefix lets `POST /oauth/revoke` tell a refresh token from a
 * PAT (`crowi_pat_`) without a DB round-trip.
 */
const RT_PREFIX = 'crowi_rt_';
const RT_RANDOM_BYTES = 32;

export interface OAuthRefreshTokenDocument extends Document {
  _id: Types.ObjectId;
  tokenHash: string;
  clientId: string;
  userId: Types.ObjectId;
  scopes: string[];
  expiresAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
  /** Successor token's hash once this one is rotated; null while active. */
  rotatedTo: string | null;
  /**
   * When the chain this token belongs to was first authorized (chain-origin
   * `authorizedAt`, carried forward on every rotation). Optional: rows
   * created before this field existed have no value, and readers fall back
   * to `createdAt` rather than backfilling.
   */
  authorizedAt?: Date;
  /**
   * Immutable sign-in family id, minted on the first grant and inherited by
   * every rotation. Optional/nullable only so pre-family rows can still be
   * read; no schema default (a default would give each legacy row its own
   * family on every load). Missing, null and '' all mean "no family".
   */
  familyId?: string | null;
}

export interface OAuthRefreshTokenModel extends Model<OAuthRefreshTokenDocument> {
  generateToken(): { token: string; tokenHash: string };
  hashToken(token: string): string;
  /**
   * Active (= not revoked, not expired) token matching `tokenHash`, or null.
   * A row without a family id is revoked on the spot and not returned; a row
   * whose family has a revocation record is not returned.
   */
  findActiveByHash(tokenHash: string): Promise<OAuthRefreshTokenDocument | null>;
  /**
   * Revoke every refresh token of a sign-in family: persist the family
   * revocation record first, then bulk-revoke the existing rows.
   */
  revokeFamily(familyId: string, userId: Types.ObjectId): Promise<void>;
  /**
   * A user's active tip documents (`revokedAt: null`, `rotatedTo: null`,
   * `expiresAt > now`), newest first. `now` is supplied by the caller (not
   * generated here) so a single request-local instant governs both the
   * expiry filter and the response serialization built from the result.
   */
  listActiveByUser(userId: Types.ObjectId, now: Date): Promise<OAuthRefreshTokenDocument[]>;

  TOKEN_PREFIX: string;
}

export default (crowi: Crowi) => {
  const schema = new Schema<OAuthRefreshTokenDocument, OAuthRefreshTokenModel>({
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    clientId: {
      type: String,
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    scopes: {
      type: [String],
      required: true,
      default: [],
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    rotatedTo: {
      type: String,
      default: null,
    },
    authorizedAt: {
      type: Date,
      required: false,
    },
    familyId: {
      type: String,
      required: false,
    },
  });

  // TTL on `expiresAt` — sweeps long-dead tokens. Active lookups filter
  // `expiresAt > now` so the sweep lag never lets an expired token through.
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'oauthRefreshToken_ttl' });

  schema.index({ familyId: 1, userId: 1 }, { name: 'oauthRefreshToken_family_user' });
  schema.index({ userId: 1, revokedAt: 1, createdAt: -1 }, { name: 'oauthRefreshToken_user_active_created' });

  schema.statics.hashToken = function (token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  };

  schema.statics.generateToken = function (): { token: string; tokenHash: string } {
    const token = `${RT_PREFIX}${crypto.randomBytes(RT_RANDOM_BYTES).toString('base64url')}`;
    return { token, tokenHash: OAuthRefreshToken.hashToken(token) };
  };

  schema.statics.findActiveByHash = async function (tokenHash: string): Promise<OAuthRefreshTokenDocument | null> {
    const row = await OAuthRefreshToken.findOne({
      tokenHash,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    })
      .read('primary')
      .exec();
    if (!row) return null;

    if (!row.familyId) {
      // Pre-family row: never rotated into a family, never given a new one.
      await OAuthRefreshToken.updateOne({ _id: row._id, userId: row.userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
      return null;
    }
    if (await crowi.model('OAuthTokenFamilyRevocation').isRevoked(row.familyId, row.userId)) return null;
    return row;
  };

  schema.statics.revokeFamily = async function (familyId: string, userId: Types.ObjectId): Promise<void> {
    if (typeof familyId !== 'string' || familyId.length === 0) {
      throw new Error('revokeFamily requires a non-empty familyId');
    }
    const now = new Date();
    // Record first: a refresh that inserts its successor after the bulk
    // update below still finds the record and revokes that row itself.
    await crowi.model('OAuthTokenFamilyRevocation').markRevoked(familyId, userId, now);
    await OAuthRefreshToken.updateMany({ familyId, userId, revokedAt: null }, { $set: { revokedAt: now } });
  };

  schema.statics.listActiveByUser = function (userId: Types.ObjectId, now: Date): Promise<OAuthRefreshTokenDocument[]> {
    return OAuthRefreshToken.find({ userId, revokedAt: null, rotatedTo: null, expiresAt: { $gt: now } })
      .sort({ createdAt: -1 })
      .exec();
  };

  const OAuthRefreshToken = model<OAuthRefreshTokenDocument, OAuthRefreshTokenModel>('OAuthRefreshToken', schema);

  OAuthRefreshToken.TOKEN_PREFIX = RT_PREFIX;

  return OAuthRefreshToken;
};
