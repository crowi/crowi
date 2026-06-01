/**
 * RFC-0006 Phase 4 Batch 9 — `admin.mail` sub-contract ported to
 * `@hono/zod-openapi` route definitions.
 *
 *   GET  /admin/mail        — read the current SMTP + AWS SES settings
 *   PUT  /admin/mail        — partial-update (secret masking on input)
 *   POST /admin/mail/test   — send a test mail to the calling admin
 *
 * Auth + install:
 *   - The handler installs `createJwtAdminRequired(crowi)` broadly on
 *     `/admin/mail/*` plus the bare `/admin/mail` path.
 *
 * Validation envelope:
 *   - Both PUT and POST routes emit the custom
 *     `MailSettingsValidationErrorSchema` `{ bodyResult }` shape on body
 *     validation failure (legacy parity — same idiom as admin.app).
 */
import { createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { ZodError } from 'zod';

import {
  GetMailSettingsResponseSchema,
  MailSettingsValidationErrorSchema,
  SendTestMailErrorSchema,
  SendTestMailRequestSchema,
  SendTestMailResponseSchema,
  UpdateMailSettingsRequestSchema,
  UpdateMailSettingsResponseSchema,
} from '../../schemas/admin/mail';
import { AdminRequiredErrorSchema, AuthenticationRequiredErrorSchema } from '../../schemas/common';

const mailSettingsValidationHook = (result: { success: boolean; error?: ZodError }, c: Context): Response | undefined => {
  if (result.success) return;
  const issues = (result.error?.issues ?? []).map((i) => ({
    path: i.path.map((p): string | number => (typeof p === 'symbol' ? String(p) : p)),
    message: i.message,
  }));
  return c.json(
    {
      bodyResult: {
        issues,
        name: 'ZodError',
      },
    },
    400,
  );
};

export const getMailSettingsRoute = createRoute({
  method: 'get',
  path: '/admin/mail',
  tags: ['admin.mail'],
  security: [{ bearerAuth: [] }],
  summary: 'Read the sender-independent mail settings (from + active sender driver)',
  responses: {
    200: {
      description: 'Current mail settings',
      content: { 'application/json': { schema: GetMailSettingsResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Admin permission required',
      content: { 'application/json': { schema: AdminRequiredErrorSchema } },
    },
  },
});

export const updateMailSettingsRoute = createRoute({
  method: 'put',
  path: '/admin/mail',
  tags: ['admin.mail'],
  security: [{ bearerAuth: [] }],
  summary: 'Update the sender-independent mail settings (from address)',
  hook: mailSettingsValidationHook,
  request: {
    body: {
      content: { 'application/json': { schema: UpdateMailSettingsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Update succeeded',
      content: { 'application/json': { schema: UpdateMailSettingsResponseSchema } },
    },
    400: {
      description: 'Body validation failed (legacy `{ bodyResult }` envelope)',
      content: { 'application/json': { schema: MailSettingsValidationErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Admin permission required',
      content: { 'application/json': { schema: AdminRequiredErrorSchema } },
    },
  },
});

export const sendTestMailRoute = createRoute({
  method: 'post',
  path: '/admin/mail/test',
  tags: ['admin.mail'],
  security: [{ bearerAuth: [] }],
  summary: 'Send a test mail to the calling admin (req.user.email) via the active sender',
  hook: mailSettingsValidationHook,
  request: {
    body: {
      content: { 'application/json': { schema: SendTestMailRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Test mail sent successfully',
      content: { 'application/json': { schema: SendTestMailResponseSchema } },
    },
    400: {
      description: 'Body validation failed',
      content: { 'application/json': { schema: MailSettingsValidationErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Admin permission required',
      content: { 'application/json': { schema: AdminRequiredErrorSchema } },
    },
    502: {
      description: 'Test mail dispatch failed (SMTP error)',
      content: { 'application/json': { schema: SendTestMailErrorSchema } },
    },
  },
});

export const adminMailRoutes = {
  getMailSettingsRoute,
  updateMailSettingsRoute,
  sendTestMailRoute,
};

export type {
  GetMailSettingsResponse,
  MailSettingsValidationError,
  SendTestMailError,
  SendTestMailRequest,
  SendTestMailResponse,
  UpdateMailSettingsRequest,
  UpdateMailSettingsResponse,
} from '../../schemas/admin/mail';
