import crypto from 'node:crypto';

/**
 * RFC-0010 Phase 4 (RFC 8628 §6.1) — human-typed `user_code` generation.
 *
 * The user types this code into `/oauth/device` on a second device, so the
 * alphabet deliberately drops ambiguous glyphs:
 *
 *  - vowels (A E I O U) — avoids accidentally spelling words.
 *  - look-alikes 0/O, 1/I/L — removed from the letter set; digits 0-9 are
 *    kept but the letters that resemble them are not, so a `0` is always a
 *    digit and an `I` never appears.
 *
 * Format is `ABCD-1234` (4 letters + dash + 4 digits). Uniqueness is the
 * caller's responsibility: the `OAuthDeviceCode` model has a unique index on
 * `userCode` and retries generation on a duplicate-key error.
 */

/** Consonant-only letters, ambiguous glyphs removed (RFC 8628 §6.1). `L` is
 * dropped too — it reads as `1`/`I` in many fonts. */
const USER_CODE_LETTERS = 'BCDFGHJKMNPQRSTVWXZ';
const USER_CODE_DIGITS = '0123456789';
const LETTER_COUNT = 4;
const DIGIT_COUNT = 4;

function pick(alphabet: string, count: number): string {
  let out = '';
  for (let i = 0; i < count; i += 1) {
    out += alphabet[crypto.randomInt(alphabet.length)];
  }
  return out;
}

/** Generate a fresh `ABCD-1234`-form user code (uniqueness enforced by caller). */
export function generateUserCode(): string {
  return `${pick(USER_CODE_LETTERS, LETTER_COUNT)}-${pick(USER_CODE_DIGITS, DIGIT_COUNT)}`;
}

/**
 * Normalise a user-entered code for lookup: upper-case, strip everything that
 * is not an allowed letter/digit (spaces, dashes, etc.), then re-insert the
 * canonical dash after the 4th character when the length matches. This lets a
 * user type `abcd1234`, `abcd-1234`, or `ABCD 1234` and still match the
 * stored `ABCD-1234`.
 */
export function normalizeUserCode(input: string): string {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length === LETTER_COUNT + DIGIT_COUNT) {
    return `${cleaned.slice(0, LETTER_COUNT)}-${cleaned.slice(LETTER_COUNT)}`;
  }
  return cleaned;
}
