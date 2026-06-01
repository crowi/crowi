/**
 * Schemas for confirming a requested email-address change. The user
 * requests the change via `PUT /me` (which does NOT apply it); a
 * confirmation link is sent to the *new* address, and clicking it hits
 * these public endpoints. The signed token (purpose `'email-change'`,
 * payload `email` = the new address) is the credential.
 */
import { z } from '@hono/zod-openapi';

export const ConfirmEmailChangeRequestSchema = z.object({
  token: z.string(),
});
export type ConfirmEmailChangeRequest = z.infer<typeof ConfirmEmailChangeRequestSchema>;

export const ConfirmEmailChangeResponseSchema = z.object({
  ok: z.literal(true),
  /** The newly-confirmed email address. */
  email: z.string().email(),
});
export type ConfirmEmailChangeResponse = z.infer<typeof ConfirmEmailChangeResponseSchema>;
