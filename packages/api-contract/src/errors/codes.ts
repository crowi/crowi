import { z } from '@hono/zod-openapi';

/**
 * Canonical machine-readable error codes shared between the API and web.
 *
 * This is the single source of truth: every modern Hono handler / middleware
 * returns one of these in `{ error: { code, message } }`, and the web client
 * maps each code to a localized message (`ERROR_MESSAGE_KEYS` in
 * `packages/web/src/lib/error-message.ts`, type-checked against `ErrorCode`).
 *
 * Adding a code here forces:
 *   - api handlers to satisfy `ApiErrorSchema.error.code` (typed below), and
 *   - the web map to add a localized entry (or fail `pnpm type-check`).
 *
 * Out of scope: legacy `{ status: 'error', message, errors[] }` envelopes
 * (installer, some `me` blocks) and mail i18n (recipient `User.lang`).
 *
 * Keep this list alphabetised within each group for easy scanning.
 */
export const ERROR_CODES = [
  // --- auth / permission / user status ---
  'AUTHENTICATION_REQUIRED',
  'ADMIN_REQUIRED',
  'THIRD_PARTY_AUTH_REQUIRED',
  'USER_REGISTERED',
  'USER_SUSPENDED',
  'USER_INVITED',
  'USER_NOT_ACTIVE',
  'EMAIL_NOT_CONFIRMED',
  // --- generic / transport ---
  'INTERNAL_ERROR',
  'VALIDATION_ERROR',
  'INVALID_REQUEST',
  'NOT_FOUND',
  'CONFLICT',
  'SERVICE_UNAVAILABLE',
  'APPLICATION_NOT_INSTALLED',
  // --- page domain ---
  'INVALID_PAGE_ID',
  'PAGE_NOT_FOUND',
  'PAGE_NOT_GRANTED',
  'PAGE_REVISION_ERROR',
  'PAGE_TWIN_EXISTS',
  'INVALID_GRANT',
  // --- comment / notification domain ---
  'COMMENT_NOT_FOUND',
  'NOTIFICATION_NOT_FOUND',
  // --- user / account domain ---
  'USER_NOT_FOUND',
  'USER_EXISTS',
  'USERNAME_TAKEN',
  'EMAIL_TAKEN',
  'EMAIL_NOT_ALLOWED',
  // --- token-based flows (activation / invite / reset / email change) ---
  'INVALID_ACTIVATION_TOKEN',
  'INVALID_INVITE_TOKEN',
  'INVITE_ALREADY_ACCEPTED',
  'INVALID_RESET_TOKEN',
  'INVALID_EMAIL_CHANGE_TOKEN',
  // --- login / registration ---
  'INVALID_CREDENTIALS',
  'REFRESH_TOKEN_REQUIRED',
  'REGISTRATION_CLOSED',
  // --- federated sign-in (RFC-0014) ---
  'FEDERATED_HANDOFF_INVALID',
  'FEDERATED_HANDOFF_CONSUMED',
  // --- admin subsystems ---
  'ENCRYPTION_NOT_CONFIGURED',
  'MAIL_TEST_FAILED',
  'PLUGIN_NOT_FOUND',
  'PLUGIN_CONFIG_VALIDATION_FAILED',
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES).openapi('ErrorCode');

export type ErrorCode = (typeof ERROR_CODES)[number];
