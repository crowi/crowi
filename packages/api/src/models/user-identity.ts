import { Document, Model, Schema, Types, model } from 'mongoose';

import Crowi from 'src/crowi';

/**
 * RFC-0014 §7 — `UserIdentity` collection.
 *
 * The persistence target for federated (OAuth 2.0 / OIDC) sign-in: one row
 * per `(Crowi user, provider)` pair, linking a Crowi `User` to a provider
 * subject (`providerUserId`, e.g. Google's `sub` claim). This is a
 * **model-and-index-only** Phase 0 addition — no create/find/delete logic
 * or provider refresh-token encryption ships yet; later phases (JIT
 * provisioning, link/unlink) own that.
 *
 * `User.googleId` / `User.githubId` are legacy v1 columns this collection
 * deliberately does not read, write, or migrate from (umbrella spec
 * `feature-auth-plugin-google.md` §"全フェーズに共通する確定事項").
 *
 * The two unique indexes are the actual ownership invariant:
 *  - `{ provider: 1, providerUserId: 1 }` — a provider subject resolves to
 *    at most one Crowi user (prevents identity confusion across users).
 *  - `{ userId: 1, provider: 1 }` — a Crowi user has at most one identity
 *    per provider (Google + GitHub can coexist; two Google accounts on the
 *    same user cannot).
 */
export interface UserIdentityDocument extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  provider: string;
  providerUserId: string;
  linkedAt: Date;
  /** Encrypted provider refresh token, when the provider issues one. */
  providerRefreshTokenEnc?: string;
}

// biome-ignore lint/suspicious/noEmptyInterface: Phase 0 adds no statics/instance methods yet (see doc comment above) — the type alias exists so later phases have a stable place to add them.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface UserIdentityModel extends Model<UserIdentityDocument> {}

export default (_crowi: Crowi) => {
  const schema = new Schema<UserIdentityDocument, UserIdentityModel>({
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    provider: {
      type: String,
      required: true,
    },
    providerUserId: {
      type: String,
      required: true,
    },
    linkedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    providerRefreshTokenEnc: {
      type: String,
      required: false,
    },
  });

  schema.index({ provider: 1, providerUserId: 1 }, { unique: true, name: 'userIdentity_provider_providerUserId_unique' });
  schema.index({ userId: 1, provider: 1 }, { unique: true, name: 'userIdentity_userId_provider_unique' });
  schema.index({ userId: 1 }, { name: 'userIdentity_userId' });

  // Explicit collection name — RFC-0014 §7 names the physical collection
  // `user_identities`. Mongoose's default pluralization of `'UserIdentity'`
  // would otherwise produce `useridentities`.
  const UserIdentity = model<UserIdentityDocument, UserIdentityModel>('UserIdentity', schema, 'user_identities');

  return UserIdentity;
};
