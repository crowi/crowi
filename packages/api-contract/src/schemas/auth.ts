import { z } from '@hono/zod-openapi';

// Token-based authentication schemas
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

// Legacy schemas (to be removed)
export const LoginRequestSchema = z.object({
  loginForm: z.object({
    email: z.string().email(),
    password: z.string().min(6),
  }),
  toConnect: z.boolean().optional(),
});

export const LoginResponseSchema = z.object({
  continueUrl: z.string().optional(),
  toConnect: z.boolean().optional(),
  targetUser: z.any().optional(), // User object
  socialId: z.string().optional(),
  socialEmail: z.string().optional(),
  socialName: z.string().optional(),
  socialImage: z.string().optional(),
  googleId: z.string().optional(),
  githubId: z.string().optional(),
  issuerName: z.string().optional(),
});

// Token-based registration schemas
export const TokenAuthRegisterRequestSchema = z.object({
  username: z.string(),
  name: z.string(),
  email: z.string().email(),
  password: z.string().min(6),
});

// Legacy schemas (to be removed)
export const RegisterRequestSchema = z.object({
  registerForm: z.object({
    username: z.string(),
    name: z.string(),
    email: z.string().email(),
    password: z.string().min(6),
    googleId: z.string().optional(),
    githubId: z.string().optional(),
    socialImage: z.string().optional(),
  }),
});

export const RegisterResponseSchema = z.object({
  isRegistering: z.boolean().optional(),
  toConnect: z.boolean().optional(),
  targetUser: z.any().optional(), // User object
  error: z.string().optional(),
  socialId: z.string().optional(),
  socialEmail: z.string().optional(),
  socialName: z.string().optional(),
  socialImage: z.string().optional(),
  googleId: z.string().optional(),
  githubId: z.string().optional(),
  issuerName: z.string().optional(),
});

export const ErrorResponseSchema = z.object({
  reason: z.string(),
  reasonMessage: z.string(),
});
