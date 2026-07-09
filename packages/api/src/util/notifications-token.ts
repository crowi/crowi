import crypto from 'node:crypto';
import { NotificationsTokenPayloadSchema, type NotificationsTokenPayload } from '@crowi/api-contract';

import { createSignedTokenUtil } from './signed-token-factory';

/**
 * Issuer claim used to sign / verify notifications tokens.
 *
 * Distinct from the collab wsToken issuer (`'crowi-collab'`, see
 * `util/ws-token.ts`), the presence token issuer (`'crowi-presence'`,
 * see `util/presence-token.ts`), and the HTTP access/refresh token
 * issuer (`'crowi'`). The three WebSocket issuers all share the same
 * `WS_TOKEN_SECRET` key material but verify against different `iss`
 * claims, so a leaked token for one channel is never replayable
 * against the others — `/collab` carries write access to the Y.Doc,
 * `/presence` is per-page viewer tracking, `/notifications` is the
 * per-user invalidation channel.
 */
const NOTIFICATIONS_TOKEN_ISSUER = 'crowi-notifications';

/**
 * Lifetime of an issued notifications token. 60 seconds — short enough
 * that a leaked token has minimal blast radius (the notifications
 * channel only carries `{type:'changed'}` ticks, no notification data,
 * so a hijacked subscription is a low-value target but the principle
 * of least privilege still applies). The browser uses `expiresAt` to
 * proactively re-fetch ~30s before expiry; the realistic refresh
 * cadence becomes ~30s rather than the 5-minute presence cadence.
 */
const NOTIFICATIONS_TOKEN_TTL_SECONDS = 60;

/** Claims signed into a notifications token. */
export interface NotificationsTokenClaims {
  /**
   * The requesting user's `_id`. The `/notifications/<userId>` WS
   * handshake rejects a token whose `selfUserId` does not match the
   * URL path segment so one user can never subscribe to another's
   * channel even with a valid token.
   */
  selfUserId: string;
}

export interface SignNotificationsTokenResult {
  /** Compact JWT string presented by the browser on the WebSocket connect. */
  token: string;
  /** Absolute expiry timestamp; mirrors `exp * 1000` as a Date. */
  expiresAt: Date;
}

/**
 * Thin wrapper around `createSignedTokenUtil` (secret resolution —
 * placeholder rejection included — memoization, sign, verify all live
 * there now; see `util/signed-token-factory.ts`).
 *
 * A fresh `jti` (random UUID) is mixed into the payload on every sign
 * so two tokens minted within the same second are byte-different. The
 * browser uses the token string as a react `useEffect` dependency (it
 * dials the WebSocket whenever the token changes) — without a `jti`,
 * the iat/exp pair is identical and the dep stays stable, so a re-mint
 * at the same second does not trigger the effect. The verifier ignores
 * `jti` beyond schema validation, keeping the token stateless. This is
 * notifications-specific wiring, so it stays here rather than in the
 * shared factory.
 */
export function createNotificationsTokenUtil() {
  const util = createSignedTokenUtil<NotificationsTokenClaims & { jti: string }, NotificationsTokenPayload>({
    issuer: NOTIFICATIONS_TOKEN_ISSUER,
    ttlSeconds: NOTIFICATIONS_TOKEN_TTL_SECONDS,
    payloadSchema: NotificationsTokenPayloadSchema,
  });

  function signNotificationsToken(claims: NotificationsTokenClaims): SignNotificationsTokenResult {
    return util.sign({ ...claims, jti: crypto.randomUUID() });
  }

  return {
    signNotificationsToken,
    verifyNotificationsToken: (token: string): NotificationsTokenPayload | null => util.verify(token),
    ttlSeconds: NOTIFICATIONS_TOKEN_TTL_SECONDS,
    issuer: NOTIFICATIONS_TOKEN_ISSUER,
  };
}

export type NotificationsTokenUtil = ReturnType<typeof createNotificationsTokenUtil>;
