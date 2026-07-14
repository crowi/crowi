import { type WsTokenPayload, WsTokenPayloadSchema } from '@crowi/api-contract';

import { createSignedTokenUtil, isSignedTokenSecretConfiguredFromEnv } from './signed-token-factory';

/**
 * Issuer claim used to sign / verify wsTokens. Distinct from the
 * access/refresh token issuer (`'crowi'`) so a leaked access-token
 * secret can never be replayed against Hocuspocus, and a leaked
 * wsToken secret can never be replayed against the HTTP JWT auth.
 */
const WS_TOKEN_ISSUER = 'crowi-collab';

/**
 * Lifetime of an issued wsToken. Hocuspocus refuses tokens whose `exp`
 * has passed; the browser provider uses `expiresAt` to proactively
 * refresh well before the WebSocket would otherwise be torn down.
 * Five minutes is short enough that a leaked token has limited blast
 * radius and long enough to cover typical reconnect storms.
 */
const WS_TOKEN_TTL_SECONDS = 300;

/**
 * Claims signed into the wsToken. The exported runtime schema lives in
 * `@crowi/api-contract` (`WsTokenPayloadSchema`) — Phase 3 Hocuspocus
 * code parses the verified payload through the same schema, so the
 * shape only has one source of truth.
 */
export interface WsTokenClaims {
  userId: string;
  pageId: string;
  readonly: boolean;
  /**
   * RFC-0017 Phase 1 — the page's `collabLifecycleVersion` at mint time.
   * `onAuthenticate` refuses (reject-and-remint) any token whose `epoch`
   * doesn't match the page's CURRENT value, closing the rename/delete
   * self-invalidation hole documented in
   * `docs/rfcs/0017-collab-invalidate-on-rename-delete.md` §0.1.
   */
  epoch: number;
}

export interface SignWsTokenResult {
  /** Compact JWT string presented by the browser provider on connect. */
  token: string;
  /** ISO 8601 expiry timestamp, mirrors `exp * 1000` as a Date. */
  expiresAt: Date;
}

/**
 * Thin wrapper around `createSignedTokenUtil` (secret resolution —
 * placeholder rejection included — memoization, sign, verify all live
 * there now; see `util/signed-token-factory.ts`). Each call builds a
 * fresh util bound to the currently-resolved secret: when
 * `WS_TOKEN_SECRET` is set, that's a fresh env read every time; when
 * unset, the factory's process-wide random fallback keeps mint and
 * verify agreeing regardless of which `createWsTokenUtil()` call built
 * which instance.
 */
export function createWsTokenUtil() {
  const util = createSignedTokenUtil<WsTokenClaims, WsTokenPayload>({
    issuer: WS_TOKEN_ISSUER,
    ttlSeconds: WS_TOKEN_TTL_SECONDS,
    payloadSchema: WsTokenPayloadSchema,
  });

  return {
    signWsToken: (claims: WsTokenClaims): SignWsTokenResult => util.sign(claims),
    verifyWsToken: (token: string): WsTokenPayload | null => util.verify(token),
    ttlSeconds: WS_TOKEN_TTL_SECONDS,
    issuer: WS_TOKEN_ISSUER,
  };
}

/**
 * Whether `WS_TOKEN_SECRET` is a REAL configured secret (vs unset /
 * empty / a known placeholder, in which case we use the per-process
 * random fallback). editor-preview-reliability §4 / E1 uses this at
 * boot to fail-fast on a declared multi-instance deployment: a random
 * fallback secret can only be verified by the process that minted it,
 * so a second replica rejects every wsToken it didn't issue ("WebSocket
 * closed before the connection was established"). Delegates the actual
 * placeholder judgement to `signed-token-factory.ts` so this stays the
 * single source of truth shared with `resolveSignedTokenSecret`. Kept
 * under this ws-specific name (rather than renamed) so
 * `collab/attach.ts`'s import stays unchanged.
 */
export function isWsTokenSecretFromEnv(): boolean {
  return isSignedTokenSecretConfiguredFromEnv('WS_TOKEN_SECRET');
}
