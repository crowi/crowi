/**
 * RFC-0006 Phase 4 Batch 8 — `adminCrypto` resource ported to
 * `@hono/zod-openapi` route definitions. Two endpoints:
 *
 *   GET  /admin/crypto/status      — sensitive Config row status report
 *   POST /admin/crypto/reencrypt   — re-encrypt every plaintext sensitive
 *                                    Config row with the current key
 *
 * Auth + install:
 *   - Both endpoints sit under `/admin/crypto/*` and are admin-only
 *     (JWT + `user.admin === true`). The Hono handler installs
 *     `createJwtAdminRequired(crowi)` on the two literal paths so any
 *     non-admin caller short-circuits with a 403 `AdminRequiredError`
 *     envelope before the handler runs. Same install pattern as
 *     `search` / `/users/autocomplete` (per-path) but with the
 *     admin-required factory (Batch 8 is the first time
 *     `jwtAdminRequired` lands on Hono).
 *   - Other admin sub-resources (Batch 9: `/admin/app`, `/admin/auth`,
 *     `/admin/security` etc.) own their own path prefix and install
 *     `createJwtAdminRequired(crowi)` independently — this contract does
 *     NOT broaden the apply to `/admin/*`.
 *
 * The `reencryptAll` request body is empty in practice; declared as
 * `z.unknown()` so Express body-parser's `{}`-on-empty-POST hydration
 * validates cleanly (same idiom as `notification.markAllAsRead` /
 * `openNotification`).
 *
 * 503 `EncryptionNotConfiguredError` is returned by `reencryptAll` when
 * `CROWI_ENCRYPTION_KEY` is not set — `getCryptoStatus` reports the same
 * fact via the `encryptionConfigured: false` flag (no 503 there).
 */
import { createRoute, z } from '@hono/zod-openapi';

import { AdminRequiredErrorSchema, AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../schemas/common';
import { CryptoStatusResponseSchema, EncryptionNotConfiguredErrorSchema, ReencryptResponseSchema } from '../schemas/adminCrypto';

export const getCryptoStatusRoute = createRoute({
  method: 'get',
  path: '/admin/crypto/status',
  tags: ['adminCrypto'],
  security: [{ bearerAuth: [] }],
  summary: 'Report which sensitive Config values are still plaintext',
  responses: {
    200: {
      description: 'Per-(ns, key) status for every sensitive Config row',
      content: { 'application/json': { schema: CryptoStatusResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Admin permission required',
      content: { 'application/json': { schema: AdminRequiredErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const reencryptAllRoute = createRoute({
  method: 'post',
  path: '/admin/crypto/reencrypt',
  tags: ['adminCrypto'],
  security: [{ bearerAuth: [] }],
  summary: 'Re-encrypt every plaintext sensitive Config value with the current key',
  responses: {
    200: {
      description: 'Migration completed (counts reported)',
      content: { 'application/json': { schema: ReencryptResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Admin permission required',
      content: { 'application/json': { schema: AdminRequiredErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
    503: {
      description: 'CROWI_ENCRYPTION_KEY is not configured on the server',
      content: { 'application/json': { schema: EncryptionNotConfiguredErrorSchema } },
    },
  },
});

export const adminCryptoRoutes = {
  getCryptoStatusRoute,
  reencryptAllRoute,
};
