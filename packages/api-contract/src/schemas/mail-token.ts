/**
 * Schema for the stateless, signed tokens embedded in transactional
 * email links (invite acceptance, account activation, password reset).
 *
 * The token is a JWT signed with `WS_TOKEN_SECRET` under the
 * `crowi-mail-token` issuer (see `packages/api/src/util/mail-token.ts`),
 * so `exp` and signature are enforced by the JWT layer; the `purpose`
 * claim scopes a token to a single flow (an invite token can never be
 * replayed against the password-reset endpoint).
 */
import { z } from '@hono/zod-openapi';

export const MailTokenPurposeSchema = z.enum(['invite', 'activate', 'reset', 'email-change']);
export type MailTokenPurpose = z.infer<typeof MailTokenPurposeSchema>;

export const MailTokenPayloadSchema = z.object({
  purpose: MailTokenPurposeSchema,
  userId: z.string(),
  /** Target address. For `email-change` this is the NEW address. */
  email: z.string().email(),
  /**
   * For `email-change`: the account's email at issue time. The confirm
   * endpoint rejects the token unless it still matches, making the token
   * single-use (a stale token cannot revert a later change).
   */
  fromEmail: z.string().email().optional(),
  /**
   * For `reset`: the account's `passwordResetGeneration` at issue time.
   * Consuming the link increments that counter, so the token only matches
   * once — without it a reset JWT stays usable for its entire 1h TTL and
   * can be replayed by anyone who later reaches the link. Optional in the
   * schema because the other purposes don't carry it (and links minted
   * before the claim existed simply no longer match).
   */
  resetGeneration: z.number().int().nonnegative().optional(),
  // iat / exp are injected and verified by the JWT layer.
  iat: z.number().optional(),
  exp: z.number().optional(),
});
export type MailTokenPayload = z.infer<typeof MailTokenPayloadSchema>;
