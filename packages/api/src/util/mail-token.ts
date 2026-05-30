import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { type MailTokenPayload, MailTokenPayloadSchema, type MailTokenPurpose } from '@crowi/api-contract';
import Debug from 'debug';

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
}

export interface SignMailTokenResult {
  /** Compact JWT to embed in the email link's `?token=` query. */
  token: string;
  /** Absolute expiry; mirrors `exp * 1000`. */
  expiresAt: Date;
}

// One-time load-time warning when the signing key is absent. Silenced
// under tests (the model layer imports this transitively before each
// file's env stub runs). Mirrors `util/notifications-token.ts`.
if ((!process.env.WS_TOKEN_SECRET || process.env.WS_TOKEN_SECRET.length === 0) && process.env.NODE_ENV !== 'test') {
  console.warn(
    '[crowi] WS_TOKEN_SECRET is not set — mail tokens (invite / activate / reset links) will be signed ' +
      'with a random in-memory secret. Process restarts will invalidate outstanding links, and multi-instance ' +
      'deployments will not be able to cross-verify them. Set WS_TOKEN_SECRET to a stable base64-encoded ' +
      '32-byte value (`openssl rand -base64 32`) in production.',
  );
}

/**
 * Process-wide random fallback secret, generated at most once. Must NOT
 * be per-call: a mail token is signed in one request (e.g. the invite
 * email) and verified in a later, separate request (the accept link) —
 * often by a different `createMailTokenUtil()` instance. If each call
 * minted its own random secret, every cross-handler token would fail
 * verification whenever WS_TOKEN_SECRET is unset.
 */
let fallbackSecret: string | null = null;

/**
 * Resolve the signing secret. Reads WS_TOKEN_SECRET per call so a test
 * mutating the env between imports still picks up the latest value; the
 * random fallback is memoized process-wide (the load-time warn above
 * reports the env miss).
 */
const resolveMailTokenSecret = (): string => {
  const fromEnv = process.env.WS_TOKEN_SECRET;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  if (!fallbackSecret) {
    fallbackSecret = crypto.randomBytes(32).toString('base64');
  }
  return fallbackSecret;
};

function buildMailTokenUtil() {
  const secret = resolveMailTokenSecret();

  function signMailToken(claims: MailTokenClaims): SignMailTokenResult {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + MAIL_TOKEN_TTL_SECONDS[claims.purpose];
    const token = jwt.sign({ ...claims, iat, exp }, secret, {
      issuer: MAIL_TOKEN_ISSUER,
      algorithm: 'HS256',
    });
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /**
   * Verify a mail token and require its `purpose` to match. Returns the
   * validated payload, or `null` for any failure (expired, bad
   * signature, wrong issuer, malformed claims, purpose mismatch).
   */
  function verifyMailToken(token: string, expectedPurpose: MailTokenPurpose): MailTokenPayload | null {
    try {
      const decoded = jwt.verify(token, secret, {
        issuer: MAIL_TOKEN_ISSUER,
        algorithms: ['HS256'],
      });
      const parsed = MailTokenPayloadSchema.safeParse(decoded);
      if (!parsed.success) {
        debug('mail token payload failed schema validation:', parsed.error.issues);
        return null;
      }
      if (parsed.data.purpose !== expectedPurpose) {
        debug('mail token purpose mismatch: expected %s, got %s', expectedPurpose, parsed.data.purpose);
        return null;
      }
      return parsed.data;
    } catch (err) {
      debug('mail token verification failed:', (err as Error).message);
      return null;
    }
  }

  return { signMailToken, verifyMailToken, issuer: MAIL_TOKEN_ISSUER, ttlSeconds: MAIL_TOKEN_TTL_SECONDS };
}

export type MailTokenUtil = ReturnType<typeof buildMailTokenUtil>;

export function createMailTokenUtil(): MailTokenUtil {
  return buildMailTokenUtil();
}
