import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { TokenAuthLoginRequestSchema, TokenAuthRegisterRequestSchema, TokenAuthResponseSchema, RefreshTokenRequestSchema } from '../schemas/auth';
import { ApplicationNotInstalledErrorSchema, AuthenticationRequiredErrorSchema, ApiErrorSchema } from '../schemas/common';

const c = initContract();

export const tokenAuthContract = c.router({
  tokenLogin: {
    method: 'POST',
    path: '/auth/login',
    body: TokenAuthLoginRequestSchema,
    responses: {
      200: TokenAuthResponseSchema,
      400: ApiErrorSchema,
      401: ApiErrorSchema,
      503: ApplicationNotInstalledErrorSchema,
    },
    summary: 'Authenticate user and receive tokens',
  },
  tokenRegister: {
    method: 'POST',
    path: '/auth/register',
    body: TokenAuthRegisterRequestSchema,
    responses: {
      201: TokenAuthResponseSchema,
      400: ApiErrorSchema,
      409: ApiErrorSchema, // Conflict - user already exists
      503: ApplicationNotInstalledErrorSchema,
    },
    summary: 'Register new user and receive tokens',
  },
  tokenRefresh: {
    method: 'POST',
    path: '/auth/refresh',
    body: RefreshTokenRequestSchema,
    responses: {
      200: TokenAuthResponseSchema,
      401: AuthenticationRequiredErrorSchema,
    },
    summary: 'Refresh access token using refresh token',
  },
  tokenLogout: {
    method: 'POST',
    path: '/auth/logout',
    headers: z.object({
      authorization: z.string().regex(/^Bearer .+$/),
    }),
    body: z.object({
      refreshToken: z.string().optional(),
    }),
    responses: {
      200: z.object({ message: z.string() }),
      401: AuthenticationRequiredErrorSchema,
    },
    summary: 'Logout user and invalidate tokens',
  },
  tokenMe: {
    method: 'GET',
    path: '/auth/me',
    headers: z.object({
      authorization: z.string().regex(/^Bearer .+$/),
    }),
    responses: {
      200: z.object({
        user: z.object({
          id: z.string(),
          username: z.string(),
          email: z.string().email(),
          name: z.string(),
          image: z.string().optional(),
          status: z.number(),
          createdAt: z.string(),
        }),
      }),
      401: AuthenticationRequiredErrorSchema,
    },
    summary: 'Get current user information',
  },
});
