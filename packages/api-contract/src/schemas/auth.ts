import { z } from 'zod';

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