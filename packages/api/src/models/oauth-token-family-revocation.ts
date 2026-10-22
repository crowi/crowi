import { Document, Model, Schema, Types, model } from 'mongoose';

import type Crowi from 'src/crowi';

/**
 * Permanent record that a refresh-token family was revoked. Refresh rows
 * expire by TTL, so revocation state must not depend on any of them still
 * existing: a refresh request that stalls past the TTL must still find the
 * family revoked when it resumes. Deliberately no TTL and no delete path.
 */
export interface OAuthTokenFamilyRevocationDocument extends Document<string> {
  _id: string;
  familyId: string;
  userId: Types.ObjectId;
  revokedAt: Date;
}

export interface OAuthTokenFamilyRevocationModel extends Model<OAuthTokenFamilyRevocationDocument> {
  /** Persist the revocation. Idempotent; the first `revokedAt` is kept. */
  markRevoked(familyId: string, userId: Types.ObjectId, now: Date): Promise<void>;
  /** Primary read. Throws on failure — never rounds an error to `false`. */
  isRevoked(familyId: string, userId: Types.ObjectId): Promise<boolean>;
}

/** Deterministic `_id`: one record per (owner, family). UUIDs contain no `:`. */
export const familyRevocationKey = (familyId: string, userId: Types.ObjectId): string => `${userId.toHexString()}:${familyId}`;

const isDuplicateKeyError = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;

export default (_crowi: Crowi) => {
  const schema = new Schema<OAuthTokenFamilyRevocationDocument, OAuthTokenFamilyRevocationModel>(
    {
      _id: { type: String, required: true },
      familyId: { type: String, required: true },
      userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
      revokedAt: { type: Date, required: true },
    },
    { versionKey: false },
  );

  schema.statics.isRevoked = async function (familyId: string, userId: Types.ObjectId): Promise<boolean> {
    const found = await OAuthTokenFamilyRevocation.exists({ _id: familyRevocationKey(familyId, userId), familyId, userId }).read('primary');
    return found != null;
  };

  schema.statics.markRevoked = async function (familyId: string, userId: Types.ObjectId, now: Date): Promise<void> {
    const key = familyRevocationKey(familyId, userId);
    try {
      await OAuthTokenFamilyRevocation.updateOne({ _id: key }, { $setOnInsert: { familyId, userId, revokedAt: now } }, { upsert: true });
    } catch (err) {
      // A concurrent upsert of the same key loses with E11000; that is a
      // success only if the winner wrote the same (owner, family) record.
      if (isDuplicateKeyError(err) && (await OAuthTokenFamilyRevocation.isRevoked(familyId, userId))) return;
      throw err;
    }
  };

  const OAuthTokenFamilyRevocation = model<OAuthTokenFamilyRevocationDocument, OAuthTokenFamilyRevocationModel>('OAuthTokenFamilyRevocation', schema);

  return OAuthTokenFamilyRevocation;
};
