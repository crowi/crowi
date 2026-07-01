import crypto from 'node:crypto';

import { Document, Model, Schema, Types, model } from 'mongoose';

import Crowi from 'src/crowi';
import { generateUserCode } from 'src/util/user-code';

/**
 * RFC-0010 Phase 4 — OAuth 2.0 Device Authorization Grant device code
 * (RFC 8628).
 *
 * Issued by `POST /oauth/device/authorize` for a headless client, approved
 * (or denied) by the user at `POST /oauth/device/verify` on a second device,
 * and polled at `POST /oauth/token` (device_code grant). Storage mirrors the
 * authorization-code model:
 *
 *  - Only the SHA-256 **hash** of the opaque `device_code` is stored; the
 *    plaintext is returned once from `/oauth/device/authorize` and never
 *    persisted. `user_code` is the human-typed handle and *is* stored
 *    verbatim (it is short, single-use, and only meaningful while the row
 *    lives), guarded by a unique index.
 *  - A TTL index on `expiresAt` sweeps stale rows (~10min lifetime); the
 *    query side (`findByDeviceCodeHash` / `findByUserCode`) also filters
 *    `expiresAt > now` because the TTL monitor lags by up to a minute.
 *  - `consume` flips `consumedAt` atomically so two concurrent token polls of
 *    an approved code cannot both mint tokens.
 */
const DEVICE_CODE_RANDOM_BYTES = 32;
/** Retries on a `userCode` unique-index collision before giving up. */
const USER_CODE_MAX_ATTEMPTS = 5;

export type OAuthDeviceCodeStatus = 'pending' | 'approved' | 'denied';

export interface OAuthDeviceCodeDocument extends Document {
  _id: Types.ObjectId;
  deviceCodeHash: string;
  userCode: string;
  clientId: string;
  requestedScopes: string[];
  grantedScopes: string[];
  status: OAuthDeviceCodeStatus;
  userId: Types.ObjectId | null;
  expiresAt: Date;
  interval: number;
  lastPolledAt: Date | null;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface OAuthDeviceCodeModel extends Model<OAuthDeviceCodeDocument> {
  /** SHA-256-hex of an opaque device code (the form stored in `deviceCodeHash`). */
  hashDeviceCode(deviceCode: string): string;
  /** Generate a fresh opaque device-code plaintext + its SHA-256 hash. */
  generateDeviceCode(): { deviceCode: string; deviceCodeHash: string };
  /**
   * Create a pending device code, retrying `generateUserCode()` on a
   * `userCode` collision (unique index). Returns the saved document plus the
   * one-time plaintext `deviceCode`.
   */
  createPending(input: {
    clientId: string;
    requestedScopes: string[];
    expiresAt: Date;
    interval: number;
  }): Promise<{ doc: OAuthDeviceCodeDocument; deviceCode: string }>;
  /** A usable (unconsumed, unexpired) device code by hash, or null. */
  findByDeviceCodeHash(deviceCodeHash: string): Promise<OAuthDeviceCodeDocument | null>;
  /** An unexpired device code by its human `user_code`, or null. */
  findByUserCode(userCode: string): Promise<OAuthDeviceCodeDocument | null>;
  /** Lightweight `lastPolledAt` bump on the poll path (failures swallowed). */
  touchPolled(deviceCodeHash: string): Promise<void>;
  /**
   * Atomically mark an approved, unconsumed, unexpired code consumed and
   * return it, or null otherwise. Prevents a device code from minting tokens
   * twice even under concurrent polls.
   */
  consume(deviceCodeHash: string): Promise<OAuthDeviceCodeDocument | null>;
}

export default (_crowi: Crowi) => {
  const schema = new Schema<OAuthDeviceCodeDocument, OAuthDeviceCodeModel>({
    deviceCodeHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userCode: {
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
    requestedScopes: {
      type: [String],
      required: true,
      default: [],
    },
    grantedScopes: {
      type: [String],
      required: true,
      default: [],
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'denied'],
      required: true,
      default: 'pending',
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    interval: {
      type: Number,
      required: true,
      default: 5,
    },
    lastPolledAt: {
      type: Date,
      default: null,
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

  // TTL — MongoDB removes rows once `expiresAt` is past. The sweep can lag the
  // ~10min lifetime by up to a minute, so the lookups re-check `expiresAt`.
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'oauthDeviceCode_ttl' });

  schema.statics.hashDeviceCode = function (deviceCode: string): string {
    return crypto.createHash('sha256').update(deviceCode).digest('hex');
  };

  schema.statics.generateDeviceCode = function (): { deviceCode: string; deviceCodeHash: string } {
    const deviceCode = crypto.randomBytes(DEVICE_CODE_RANDOM_BYTES).toString('base64url');
    return { deviceCode, deviceCodeHash: OAuthDeviceCode.hashDeviceCode(deviceCode) };
  };

  schema.statics.createPending = async function (input: {
    clientId: string;
    requestedScopes: string[];
    expiresAt: Date;
    interval: number;
  }): Promise<{ doc: OAuthDeviceCodeDocument; deviceCode: string }> {
    const { deviceCode, deviceCodeHash } = OAuthDeviceCode.generateDeviceCode();
    let lastErr: unknown;
    for (let attempt = 0; attempt < USER_CODE_MAX_ATTEMPTS; attempt += 1) {
      try {
        const doc = await OAuthDeviceCode.create({
          deviceCodeHash,
          userCode: generateUserCode(),
          clientId: input.clientId,
          requestedScopes: input.requestedScopes,
          status: 'pending',
          expiresAt: input.expiresAt,
          interval: input.interval,
        });
        return { doc, deviceCode };
      } catch (err) {
        // Retry only on a duplicate `userCode`; rethrow anything else.
        if (err != null && typeof err === 'object' && 'code' in err && (err as { code?: number }).code === 11000) {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error('Failed to allocate a unique user_code');
  };

  schema.statics.findByDeviceCodeHash = function (deviceCodeHash: string): Promise<OAuthDeviceCodeDocument | null> {
    return OAuthDeviceCode.findOne({
      deviceCodeHash,
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    }).exec();
  };

  schema.statics.findByUserCode = function (userCode: string): Promise<OAuthDeviceCodeDocument | null> {
    return OAuthDeviceCode.findOne({
      userCode,
      expiresAt: { $gt: new Date() },
    }).exec();
  };

  schema.statics.touchPolled = async function (deviceCodeHash: string): Promise<void> {
    try {
      await OAuthDeviceCode.updateOne({ deviceCodeHash }, { lastPolledAt: new Date() }).exec();
    } catch {
      // Best-effort: a failed poll-timestamp bump must not block the poll.
    }
  };

  schema.statics.consume = function (deviceCodeHash: string): Promise<OAuthDeviceCodeDocument | null> {
    return OAuthDeviceCode.findOneAndUpdate(
      { deviceCodeHash, status: 'approved', consumedAt: null, expiresAt: { $gt: new Date() } },
      { consumedAt: new Date() },
      { returnDocument: 'after' },
    ).exec();
  };

  const OAuthDeviceCode = model<OAuthDeviceCodeDocument, OAuthDeviceCodeModel>('OAuthDeviceCode', schema);

  return OAuthDeviceCode;
};
