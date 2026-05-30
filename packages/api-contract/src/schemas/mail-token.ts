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
  email: z.string().email(),
  // iat / exp are injected and verified by the JWT layer.
  iat: z.number().optional(),
  exp: z.number().optional(),
});
export type MailTokenPayload = z.infer<typeof MailTokenPayloadSchema>;
