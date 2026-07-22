import { Document, Model, Schema, Types, model } from 'mongoose';

import Crowi from 'src/crowi';

/**
 * RFC-0010 §Mongoose models — OAuth 2.0 client registration.
 *
 * v1 ships two first-party clients, both seeded idempotently at boot (see
 * `util/oauth-client-seed.ts`): `crowi-cli` and the `trusted` `crowi-ios`
 * (RFC-0016 Phase 0). The model is shaped from the start to admit
 * operator-registered apps later (confidential clients with a
 * `secretHash`, arbitrary `redirectUris`), but no registration UI exists
 * in v1 — these two seeded rows are the only ones.
 *
 * Both are **public** clients: they have no secret (`secretHash: null`)
 * and authenticate purely via PKCE (RFC-0010 §Security). `crowi-cli`'s
 * `redirectUris` list the loopback hosts; the actual port is matched at
 * request time by `util/oauth-redirect-uri.ts` (loopback host match, any
 * port). `crowi-ios`'s `redirectUris` list its custom-scheme callback,
 * matched by the same util via exact string match (trusted + firstParty
 * only — see the `trusted` field below).
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
  /**
   * RFC-0016 §4.4/§14 — a `trusted` **and** `firstParty` client (i) skips
   * the web consent screen (the authorize page auto-submits instead of
   * rendering `ConsentCard` — `hono/handlers/oauth.ts` / the web
   * `/oauth/authorize` page) and (ii) may register a custom URI scheme as
   * a `redirectUri`, accepted only via exact string match
   * (`util/oauth-redirect-uri.ts`). There is no client-registration
   * endpoint in v1 — every row comes from the boot-time seed
   * (`util/oauth-client-seed.ts`) — so `trusted` can only ever be set by
   * an operator-trusted, server-seeded client, never by an
   * attacker-registered one.
   */
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
