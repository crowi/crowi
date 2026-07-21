/**
 * Token-based authentication schemas, shared by the `tokenAuth` Hono
 * contract (`packages/api-contract/src/contracts/token-auth.ts`).
 *
 * The legacy SSR-style schemas (`LoginRequestSchema`, `LoginResponseSchema`,
 * `RegisterRequestSchema`, `RegisterResponseSchema`, `ErrorResponseSchema`)
 * that backed the deleted `auth` contract were removed in RFC-0006 Phase 4
 * Batch 1 — the corresponding `/api/v2/login` / `/api/v2/register` paths
 * had no production frontend consumer and were dropped wholesale.
 */
import { z } from '@hono/zod-openapi';

export const TokenAuthLoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export const TokenAuthResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number(), // seconds until expiration
  user: z.object({
    id: z.string(),
    username: z.string(),
    email: z.string().email(),
    name: z.string(),
    image: z.string().optional(),
    admin: z.boolean().optional(),
  }),
});

export const RefreshTokenRequestSchema = z.object({
  refreshToken: z.string(),
});

export const TokenAuthRegisterRequestSchema = z.object({
  username: z.string(),
  name: z.string(),
  email: z.string().email(),
  password: z.string().min(6),
});

/**
 * Self-registration no longer auto-signs-in: the account must clear a
 * gate first. `confirmation_required` = an activation email was sent
 * (open registration with email confirmation); `approval_required` = an
 * admin must approve (restricted registration).
 */
export const RegisterPendingResponseSchema = z.object({
  status: z.enum(['confirmation_required', 'approval_required']),
});
export type RegisterPendingResponse = z.infer<typeof RegisterPendingResponseSchema>;
