import crypto from 'node:crypto';

import { Document, Model, Schema, Types, model } from 'mongoose';

import Crowi from 'src/crowi';

/**
 * RFC-0010 §Mongoose models — OAuth 2.0 authorization code (Auth Code +
 * PKCE flow).
 *
 * Issued by `POST /oauth/authorize` after the user consents, exchanged
 * once at `POST /oauth/token` for an access + refresh token. Short-lived
 * (~60s) and single-use:
 *
 *  - Only the SHA-256 **hash** of the opaque code is stored; the plaintext
 *    travels via the redirect URI and is never persisted (same one-way
 *    storage as PATs / refresh tokens).
 *  - A TTL index on `expiresAt` lets MongoDB sweep stale rows; the query
 *    side (`findUsable`) *also* filters `expiresAt > now` because the TTL
 *    monitor runs at most once a minute and could lag the ~60s lifetime.
 *  - `consume` flips `consumedAt` atomically (`findOneAndUpdate`) so two
 *    concurrent token exchanges of the same code cannot both succeed.
 */
const CODE_RANDOM_BYTES = 32;

export interface OAuthAuthorizationCodeDocument extends Document {
  _id: Types.ObjectId;
  codeHash: string;
  clientId: string;
  userId: Types.ObjectId;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  redirectUri: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface OAuthAuthorizationCodeModel extends Model<OAuthAuthorizationCodeDocument> {
  /** Generate a fresh opaque code plaintext + its SHA-256 hash. */
  generateCode(): { code: string; codeHash: string };
  /** SHA-256-hex of an opaque code (the form stored in `codeHash`). */
  hashCode(code: string): string;
  /** A usable (= unconsumed, unexpired) code matching `codeHash`, or null. */
  findUsable(codeHash: string): Promise<OAuthAuthorizationCodeDocument | null>;
  /**
   * Atomically mark a usable code consumed and return it, or null if it was
   * already consumed / expired / unknown. Prevents a code from being
   * exchanged twice even under concurrent requests.
   */
  consume(codeHash: string): Promise<OAuthAuthorizationCodeDocument | null>;
}

export default (_crowi: Crowi) => {
  const schema = new Schema<OAuthAuthorizationCodeDocument, OAuthAuthorizationCodeModel>({
    codeHash: {
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
    codeChallenge: {
      type: String,
      required: true,
    },
    codeChallengeMethod: {
      type: String,
      enum: ['S256'],
      required: true,
    },
    redirectUri: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    consumedAt: {
      type: Date,
      default: null,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  });

  // TTL — MongoDB removes rows once `expiresAt` is in the past
  // (`expireAfterSeconds: 0`). The sweep can lag the ~60s lifetime by up
  // to a minute, so `findUsable` / `consume` re-check `expiresAt` too.
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'oauthAuthCode_ttl' });

  schema.statics.hashCode = function (code: string): string {
    return crypto.createHash('sha256').update(code).digest('hex');
  };

  schema.statics.generateCode = function (): { code: string; codeHash: string } {
    const code = crypto.randomBytes(CODE_RANDOM_BYTES).toString('base64url');
    return { code, codeHash: OAuthAuthorizationCode.hashCode(code) };
  };

  schema.statics.findUsable = function (codeHash: string): Promise<OAuthAuthorizationCodeDocument | null> {
    return OAuthAuthorizationCode.findOne({
      codeHash,
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    }).exec();
  };

  schema.statics.consume = function (codeHash: string): Promise<OAuthAuthorizationCodeDocument | null> {
    return OAuthAuthorizationCode.findOneAndUpdate(
      { codeHash, consumedAt: null, expiresAt: { $gt: new Date() } },
      { consumedAt: new Date() },
      { returnDocument: 'after' },
    ).exec();
  };

  const OAuthAuthorizationCode = model<OAuthAuthorizationCodeDocument, OAuthAuthorizationCodeModel>('OAuthAuthorizationCode', schema);

  return OAuthAuthorizationCode;
};
