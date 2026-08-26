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
 * whole rotation chain is revoked via `revokeChain`, walking both backward
 * (ancestors) via `findOne({ rotatedTo })` and forward (descendants) via
 * `rotatedTo`. Both the attacker's and the legitimate client's tokens die,
 * forcing a fresh authorization.
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
}

export interface OAuthRefreshTokenModel extends Model<OAuthRefreshTokenDocument> {
  generateToken(): { token: string; tokenHash: string };
  hashToken(token: string): string;
  /** Active (= not revoked, not expired) token matching `tokenHash`, or null. */
  findActiveByHash(tokenHash: string): Promise<OAuthRefreshTokenDocument | null>;
  /**
   * Revoke the entire rotation chain a token belongs to (reuse detection).
   * Walks descendants via `rotatedTo` and ancestors via the reverse link.
   */
  revokeChain(tokenHash: string): Promise<void>;
  /**
   * A user's active tip documents (`revokedAt: null`, `rotatedTo: null`,
   * `expiresAt > now`), newest first. `now` is supplied by the caller (not
   * generated here) so a single request-local instant governs both the
   * expiry filter and the response serialization built from the result.
   */
  listActiveByUser(userId: Types.ObjectId, now: Date): Promise<OAuthRefreshTokenDocument[]>;

  TOKEN_PREFIX: string;
}

export default (_crowi: Crowi) => {
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
  });

  // TTL on `expiresAt` — sweeps long-dead tokens. Active lookups filter
  // `expiresAt > now` so the sweep lag never lets an expired token through.
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'oauthRefreshToken_ttl' });

  schema.statics.hashToken = function (token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  };

  schema.statics.generateToken = function (): { token: string; tokenHash: string } {
    const token = `${RT_PREFIX}${crypto.randomBytes(RT_RANDOM_BYTES).toString('base64url')}`;
    return { token, tokenHash: OAuthRefreshToken.hashToken(token) };
  };

  schema.statics.findActiveByHash = function (tokenHash: string): Promise<OAuthRefreshTokenDocument | null> {
    return OAuthRefreshToken.findOne({
      tokenHash,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    }).exec();
  };

  schema.statics.revokeChain = async function (tokenHash: string): Promise<void> {
    const now = new Date();
    const seen = new Set<string>();
    // Forward + backward frontier of hashes to revoke.
    const queue: string[] = [tokenHash];

    while (queue.length > 0) {
      const hash = queue.shift();
      if (hash == null || seen.has(hash)) continue;
      seen.add(hash);

      const node = await OAuthRefreshToken.findOne({ tokenHash: hash }).exec();
      if (!node) continue;

      // Descendant (the token this one rotated to).
      if (node.rotatedTo && !seen.has(node.rotatedTo)) {
        queue.push(node.rotatedTo);
      }
      // Ancestor(s) — whoever rotated *into* this hash.
      const ancestors = await OAuthRefreshToken.find({ rotatedTo: hash }).exec();
      for (const anc of ancestors) {
        if (!seen.has(anc.tokenHash)) queue.push(anc.tokenHash);
      }
    }

    await OAuthRefreshToken.updateMany({ tokenHash: { $in: [...seen] }, revokedAt: null }, { revokedAt: now });
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
