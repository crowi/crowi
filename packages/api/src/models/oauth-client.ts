import { Document, Model, Schema, Types, model } from 'mongoose';

import Crowi from 'src/crowi';

/**
 * RFC-0010 §Mongoose models — OAuth 2.0 client registration.
 *
 * v1 ships a single first-party `crowi-cli` client (seeded idempotently at
 * boot, see `util/oauth-client-seed.ts`). The model is shaped from the
 * start to admit operator-registered apps later (confidential clients with
 * a `secretHash`, arbitrary `redirectUris`), but no registration UI exists
 * in v1 — `crowi-cli` is the only row.
 *
 * `crowi-cli` is a **public** client: it has no secret (`secretHash: null`)
 * and authenticates purely via PKCE (RFC-0010 §Security). `redirectUris`
 * for it list the loopback hosts; the actual port is matched at request
 * time by `util/oauth-redirect-uri.ts` (loopback host match, any port).
 */
export type OAuthClientType = 'public' | 'confidential';

export interface OAuthClientDocument extends Document {
  _id: Types.ObjectId;
  clientId: string;
  name: string;
  type: OAuthClientType;
  /** Confidential clients only; `null` for public (PKCE) clients. */
  secretHash: string | null;
  redirectUris: string[];
  allowedScopes: string[];
  firstParty: boolean;
  /** Reserved: even a trusted client still shows the consent screen in v1. */
  trusted: boolean;
  createdAt: Date;
}

export interface OAuthClientModel extends Model<OAuthClientDocument> {
  findByClientId(clientId: string): Promise<OAuthClientDocument | null>;
}

export default (_crowi: Crowi) => {
  const schema = new Schema<OAuthClientDocument, OAuthClientModel>({
    clientId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ['public', 'confidential'],
      required: true,
    },
    secretHash: {
      type: String,
      default: null,
    },
    redirectUris: {
      type: [String],
      required: true,
      default: [],
    },
    allowedScopes: {
      type: [String],
      required: true,
      default: [],
    },
    firstParty: {
      type: Boolean,
      required: true,
      default: false,
    },
    trusted: {
      type: Boolean,
      required: true,
      default: false,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  });

  schema.statics.findByClientId = function (clientId: string): Promise<OAuthClientDocument | null> {
    return OAuthClient.findOne({ clientId }).exec();
  };

  const OAuthClient = model<OAuthClientDocument, OAuthClientModel>('OAuthClient', schema);

  return OAuthClient;
};
