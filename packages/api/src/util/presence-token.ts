import { PresenceTokenPayloadSchema, type PresenceTokenPayload } from '@crowi/api-contract';

import { createSignedTokenUtil } from './signed-token-factory';

/**
 * Issuer claim used to sign / verify presence tokens (RFC-0005).
 *
 * Deliberately distinct from the collab wsToken issuer
 * (`'crowi-collab'`, see `util/ws-token.ts`) and the HTTP access/refresh
 * token issuer (`'crowi'`). A leaked presence token must never be
 * replayable against the collab WebSocket — `/collab` carries write
 * access to the Y.Doc, `/presence` is read-only viewer tracking — so
 * the two channels verify against different `iss` claims even though
 * they share the same `WS_TOKEN_SECRET` key material.
 */
const PRESENCE_TOKEN_ISSUER = 'crowi-presence';

/**
 * Lifetime of an issued presence token. Five minutes mirrors the
 * collab wsToken TTL: short enough that a leaked token has limited
 * blast radius, long enough to cover reconnect storms. The browser
 * uses `expiresAt` to proactively re-fetch before the WebSocket would
 * otherwise be dropped.
 */
const PRESENCE_TOKEN_TTL_SECONDS = 300;

/** Claims signed into a presence token. */
export interface PresenceTokenClaims {
  userId: string;
  pageId: string;
}

export interface SignPresenceTokenResult {
  /** Compact JWT string presented by the browser on the WebSocket connect. */
  token: string;
  /** ISO 8601 expiry timestamp, mirrors `exp * 1000` as a Date. */
  expiresAt: Date;
}

/**
 * Thin wrapper around `createSignedTokenUtil` (secret resolution —
 * placeholder rejection included — memoization, sign, verify all live
 * there now; see `util/signed-token-factory.ts`). Presence reuses
 * `WS_TOKEN_SECRET` rather than introducing a new env: the two token
 * kinds are isolated by their `iss` claim, so sharing the key material
 * is safe and keeps operators from having to distribute a second
 * secret.
 */
export function createPresenceTokenUtil() {
  const util = createSignedTokenUtil<PresenceTokenClaims, PresenceTokenPayload>({
    issuer: PRESENCE_TOKEN_ISSUER,
    ttlSeconds: PRESENCE_TOKEN_TTL_SECONDS,
    payloadSchema: PresenceTokenPayloadSchema,
  });

  return {
    signPresenceToken: (claims: PresenceTokenClaims): SignPresenceTokenResult => util.sign(claims),
    verifyPresenceToken: (token: string): PresenceTokenPayload | null => util.verify(token),
    ttlSeconds: PRESENCE_TOKEN_TTL_SECONDS,
    issuer: PRESENCE_TOKEN_ISSUER,
  };
}

export type PresenceTokenUtil = ReturnType<typeof createPresenceTokenUtil>;
