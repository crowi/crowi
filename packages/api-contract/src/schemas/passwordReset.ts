/**
 * Schemas for the public self-service password-reset flow.
 *
 *   POST /auth/forgot-password — request a reset link by email
 *   GET  /auth/reset-password  — validate a reset token (page preflight)
 *   POST /auth/reset-password  — set a new password with the token
 *
 * The reset token is a signed mail token (purpose `'reset'`); see
 * `packages/api/src/util/mail-token.ts`.
 */
import { z } from '@hono/zod-openapi';

export const ForgotPasswordRequestSchema = z.object({
  email: z.string().email(),
});
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

/**
 * Always-OK response. We never reveal whether the email maps to an
 * account (anti-enumeration), so success and "no such user" look
 * identical to the caller.
 */
export const ForgotPasswordResponseSchema = z.object({
  ok: z.literal(true),
});
export type ForgotPasswordResponse = z.infer<typeof ForgotPasswordResponseSchema>;

export const ResetPasswordRequestSchema = z.object({
  token: z.string(),
  password: z.string().min(6),
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;
