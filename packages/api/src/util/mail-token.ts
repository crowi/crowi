import { type MailTokenPayload, MailTokenPayloadSchema, type MailTokenPurpose } from '@crowi/api-contract';
import Debug from 'debug';

import { createSignedTokenUtil } from './signed-token-factory';

const debug = Debug('crowi:util:mail-token');

/**
 * Issuer claim for tokens embedded in transactional email links.
 *
 * Distinct from the WebSocket issuers (`crowi-collab` / `crowi-presence`
 * / `crowi-notifications`, see `util/ws-token.ts` et al.) and the HTTP
 * access/refresh issuer (`crowi`). All of these share the same
 * `WS_TOKEN_SECRET` key material but verify against different `iss`
 * claims, so a token minted for one channel is never replayable against
 * another. A single mail-token issuer is reused across invite /
 * activate / reset; the `purpose` claim (verified per endpoint) scopes
 * each token to one flow, so an invite link cannot be replayed against
 * the password-reset endpoint.
 */
const MAIL_TOKEN_ISSUER = 'crowi-mail-token';

/**
 * Per-purpose token lifetimes (seconds). Invite links are long-lived (a
 * person may not check email immediately); reset links are short to
 * limit the blast radius of a leaked inbox.
 */
const MAIL_TOKEN_TTL_SECONDS: Record<MailTokenPurpose, number> = {
  invite: 7 * 24 * 60 * 60, // 7 days
  activate: 24 * 60 * 60, // 1 day
  reset: 60 * 60, // 1 hour
  'email-change': 24 * 60 * 60, // 1 day
};

/** Claims the caller supplies; `iat` / `exp` are added by `signMailToken`. */
export interface MailTokenClaims {
  purpose: MailTokenPurpose;
  userId: string;
  email: string;
  /** email-change only: the account's email at issue time (single-use binding). */
  fromEmail?: string;
  /** reset only: the account's `passwordResetGeneration` at issue time (single-use binding). */
  resetGeneration?: number;
  /** email-change only: the account's `authVersion` at issue time, so a pending change dies with the session that requested it. */
  authVersion?: number;
}

export interface SignMailTokenResult {
  /** Compact JWT to embed in the email link's `?token=` query. */
  token: string;
  /** Absolute expiry; mirrors `exp * 1000`. */
  expiresAt: Date;
}

/**
 * Thin wrapper around `createSignedTokenUtil` (secret resolution —
 * placeholder rejection included — memoization, sign, verify all live
 * there now; see `util/signed-token-factory.ts`). Per-purpose TTLs are
 * expressed through the factory's `ttlSeconds` claims-function form.
 * `verifyMailToken`'s purpose match check is mail-token-specific
 * wiring, so it stays here rather than in the shared factory.
 */
export function createMailTokenUtil() {
  const util = createSignedTokenUtil<MailTokenClaims, MailTokenPayload>({
    issuer: MAIL_TOKEN_ISSUER,
    ttlSeconds: (claims) => MAIL_TOKEN_TTL_SECONDS[claims.purpose],
    payloadSchema: MailTokenPayloadSchema,
  });

  /**
   * Verify a mail token and require its `purpose` to match. Returns the
   * validated payload, or `null` for any failure (expired, bad
   * signature, wrong issuer, malformed claims, purpose mismatch).
   */
  function verifyMailToken(token: string, expectedPurpose: MailTokenPurpose): MailTokenPayload | null {
    const parsed = util.verify(token);
    if (parsed === null) return null;
    if (parsed.purpose !== expectedPurpose) {
      debug('mail token purpose mismatch: expected %s, got %s', expectedPurpose, parsed.purpose);
      return null;
    }
    return parsed;
  }

  return {
    signMailToken: (claims: MailTokenClaims): SignMailTokenResult => util.sign(claims),
    verifyMailToken,
    issuer: MAIL_TOKEN_ISSUER,
    ttlSeconds: MAIL_TOKEN_TTL_SECONDS,
  };
}

export type MailTokenUtil = ReturnType<typeof createMailTokenUtil>;
