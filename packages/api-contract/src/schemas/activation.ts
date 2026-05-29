/**
 * Schemas for the public account-activation (email confirmation) flow.
 *
 *   GET  /auth/activate?token= — validate an activation token (preflight)
 *   POST /auth/activate        — confirm email, activate, and sign in
 *
 * The activation token is a signed mail token (purpose `'activate'`);
 * see `packages/api/src/util/mail-token.ts`.
 */
import { z } from '@hono/zod-openapi';

export const ActivateRequestSchema = z.object({
  token: z.string(),
});
export type ActivateRequest = z.infer<typeof ActivateRequestSchema>;

/** GET preflight result. */
export const ActivateValidationResponseSchema = z.object({
  ok: z.literal(true),
});
export type ActivateValidationResponse = z.infer<typeof ActivateValidationResponseSchema>;
