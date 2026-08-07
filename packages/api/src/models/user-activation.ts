import { Document, Model, model, Schema, Types } from 'mongoose';

import Crowi from 'src/crowi';

/**
 * RFC-0014 phase 2 §"設計の主な判断" 4 — durable `{userId}` marker recording
 * that a federated JIT registration's activation-time side effect (creating
 * the user's wiki page — `ensureUserPage`, `services/auth-registration.ts`)
 * must run exactly-once-eventually.
 *
 * Created (`pending`) BEFORE the User's ACTIVE CAS, so a crash between the
 * CAS and the side effect leaves a durable, resumable record instead of a
 * lost in-memory `'activated'` event (the failure mode this phase's spec
 * background section calls out in the legacy `statusActivate` path). Both
 * `provisionPendingRegistration`'s own post-CAS call and the `'activated'`
 * event listener (`events/user.ts#onActivated`, for the Restricted →
 * admin-approval path) drain the SAME marker via `drainUserActivation`, so
 * either caller — or both, racing — converges on one page and one `done`
 * marker.
 *
 * Lease (`claimActivationLease`, reused convention from
 * `models/oauth-device-code.ts#consume`'s atomic `findOneAndUpdate` CAS):
 * a `pending` marker, or a `running` one whose lease has expired, can be
 * claimed; a live `running` lease or a `done` marker cannot — so two
 * concurrent drains (the direct post-CAS call racing the event listener)
 * never both perform the side effect at once, and a crashed claim is
 * retried once its lease lapses.
 */
const LEASE_MS = 60 * 1000;

export type UserActivationStatus = 'pending' | 'running' | 'done';

export interface UserActivationDocument extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  status: UserActivationStatus;
  leaseExpiresAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

export interface UserActivationModel extends Model<UserActivationDocument> {
  /** Idempotent — creates a `pending` marker for `userId` if none exists yet; a no-op otherwise (preserves the current status). */
  ensurePendingMarker(userId: Types.ObjectId | string): Promise<void>;
  /**
   * CAS-claim `userId`'s marker for processing: a `pending` marker, or a
   * `running` one whose lease has lapsed, becomes `running` with a fresh
   * 60s lease and is returned. Returns `null` when the marker is `done`,
   * has a still-live lease, or does not exist.
   */
  claimActivationLease(userId: Types.ObjectId | string): Promise<UserActivationDocument | null>;
  /** Mark `userId`'s marker `done` (idempotent). */
  markActivationDone(userId: Types.ObjectId | string): Promise<void>;
}

export default (_crowi: Crowi) => {
  const schema = new Schema<UserActivationDocument, UserActivationModel>({
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['pending', 'running', 'done'], required: true, default: 'pending' },
    leaseExpiresAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
  });

  schema.index({ userId: 1 }, { unique: true, name: 'userActivation_userId_unique' });

  schema.statics.ensurePendingMarker = async function (userId): Promise<void> {
    await UserActivation.updateOne(
      { userId },
      { $setOnInsert: { userId, status: 'pending', leaseExpiresAt: null, completedAt: null, createdAt: new Date() } },
      { upsert: true },
    );
  };

  schema.statics.claimActivationLease = async function (userId): Promise<UserActivationDocument | null> {
    const now = new Date();
    const lease = new Date(now.getTime() + LEASE_MS);

    const freshlyClaimed = await UserActivation.findOneAndUpdate(
      { userId, status: 'pending' },
      { $set: { status: 'running', leaseExpiresAt: lease } },
      { returnDocument: 'after' },
    );
    if (freshlyClaimed) return freshlyClaimed;

    return UserActivation.findOneAndUpdate(
      { userId, status: 'running', leaseExpiresAt: { $lt: now } },
      { $set: { leaseExpiresAt: lease } },
      { returnDocument: 'after' },
    );
  };

  schema.statics.markActivationDone = async function (userId): Promise<void> {
    await UserActivation.updateOne({ userId }, { $set: { status: 'done', leaseExpiresAt: null, completedAt: new Date() } });
  };

  const UserActivation = model<UserActivationDocument, UserActivationModel>('UserActivation', schema, 'user_activations');

  return UserActivation;
};
