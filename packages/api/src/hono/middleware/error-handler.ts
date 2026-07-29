/**
 * Top-level Hono `onError` handler. Surfaces uncaught throws as a generic
 * 500 matching `InternalServerErrorSchema`. Per-handler 4xx mappings stay
 * in the handlers themselves (see discovery doc §7); this hook is the
 * safety net.
 */
import type { InternalServerErrorSchema } from '@crowi/api-contract';
import Debug from 'debug';
import type { Context } from 'hono';
import type { z } from 'zod';

type InternalServerError = z.infer<typeof InternalServerErrorSchema>;

const debug = Debug('crowi:hono:onError');

const INTERNAL_ERROR_BODY: InternalServerError = {
  error: {
    code: 'INTERNAL_ERROR',
    message: 'Internal server error',
  },
};

export const honoOnError = (err: Error, c: Context): Response => {
  debug('Unhandled error in Hono handler:', err);
  const res = c.json(INTERNAL_ERROR_BODY, 500);
  // `createSecurityHeaders` sets this after `await next()`, which a throw skips
  // — and it cannot be recovered with a `finally` there either, because this
  // error response is only constructed after that middleware has unwound. So
  // the error path sets it itself, keeping the header genuinely app-wide.
  res.headers.set('X-Content-Type-Options', 'nosniff');
  return res;
};
