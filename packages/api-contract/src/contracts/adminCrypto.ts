import { initContract } from '@ts-rest/core';
import { z } from '@hono/zod-openapi';
import { CryptoStatusResponseSchema, EncryptionNotConfiguredErrorSchema, ReencryptResponseSchema } from '../schemas/adminCrypto';
import { AdminRequiredErrorSchema, AuthenticationRequiredErrorSchema } from '../schemas/common';

const c = initContract();

/**
 * Admin-only crypto migration endpoints. Both require an authenticated admin
 * user (= adminRequired). The `getCryptoStatus` endpoint reports how many
 * sensitive Config rows still need to be encrypted; `reencryptAll` performs
 * the migration in one batch.
 */
export const adminCryptoContract = c.router({
  getCryptoStatus: {
    method: 'GET',
    path: '/admin/crypto/status',
    responses: {
      200: CryptoStatusResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
    },
    summary: 'Report which sensitive Config values are still plaintext',
  },
  reencryptAll: {
    method: 'POST',
    path: '/admin/crypto/reencrypt',
    // No request body — declared as an empty object so the call site is
    // `apiClient.adminCrypto.reencryptAll({ body: {} })`.
    body: z.object({}),
    responses: {
      200: ReencryptResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      // 503 when the env key is missing — the operation cannot proceed.
      503: EncryptionNotConfiguredErrorSchema,
    },
    summary: 'Re-encrypt every plaintext sensitive Config value with the current key',
  },
});
