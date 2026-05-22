/**
 * Token-based authentication schemas, shared by the `tokenAuth` Hono
 * contract (`packages/api-contract/src/contracts/tokenAuth.ts`).
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
