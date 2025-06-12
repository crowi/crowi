import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  LoginRequestSchema,
  LoginResponseSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  ErrorResponseSchema,
} from '../schemas/auth';

const c = initContract();

export const authContract = c.router({
  login: {
    method: 'GET',
    path: '/login',
    responses: {
      200: LoginResponseSchema,
    },
    summary: 'Display login page',
  },
  loginPost: {
    method: 'POST',
    path: '/login',
    body: LoginRequestSchema,
    responses: {
      200: z.undefined(), // Redirect response
      400: z.object({ errors: z.array(z.string()) }),
    },
    summary: 'Process login',
  },
  register: {
    method: 'GET',
    path: '/register',
    responses: {
      200: RegisterResponseSchema,
    },
    summary: 'Display registration page',
  },
  registerPost: {
    method: 'POST',
    path: '/register',
    body: RegisterRequestSchema,
    responses: {
      200: z.undefined(), // Redirect response
      400: z.object({ errors: z.array(z.string()) }),
    },
    summary: 'Process registration',
  },
  loginError: {
    method: 'GET',
    path: '/login/error/:reason',
    pathParams: z.object({
      reason: z.enum(['suspended', 'registered']),
    }),
    responses: {
      403: ErrorResponseSchema,
    },
    summary: 'Display login error',
  },
});