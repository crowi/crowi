/**
 * RFC-0006 Phase 4 Batch 8 — `adminCrypto` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/adminCrypto.ts`. Two
 * admin-only endpoints:
 *
 *   GET  /admin/crypto/status      — report which sensitive Config rows
 *                                    are still plaintext
 *   POST /admin/crypto/reencrypt   — re-encrypt every plaintext row
 *                                    with the current key
 *
 * Auth:
 *   - This handler is the FIRST Hono migration to install
 *     `createJwtAdminRequired(crowi)`. The middleware chains the
 *     `jwtAuth` factory internally (so `c.get('user')` is populated)
 *     then enforces `user.admin === true`, returning a 403
 *     `AdminRequiredError` envelope on failure. Wire shape is identical
 *     to the legacy `jwtAdminRequired` Express middleware.
 *   - Install is per-path (same idiom as `search` / `autocomplete`'s
 *     `/users/autocomplete`) on the two literal paths only. No other
 *     handler owns `/admin/crypto/*`, so there is no double-apply risk.
 *     Batch 9 adds the rest of the admin sub-contracts — each one
 *     installs its own `createJwtAdminRequired(crowi)` on its own
 *     prefix, mirroring the per-path pattern.
 *
 * Wire-format parity:
 *   - `getCryptoStatus` reads the raw `value` column (not via
 *     `loadAllConfig`) so the encrypted-vs-plaintext determination can
 *     branch on the `enc:v1:` prefix.
 *   - `reencryptAll` returns 503 `ENCRYPTION_NOT_CONFIGURED` when
 *     `CROWI_ENCRYPTION_KEY` is missing — same precondition as the
 *     ts-rest era. The `reencryptAll` body is `JSON.stringify`'d once
 *     by Express `body-parser` so we wrap it verbatim with `encrypt()`
 *     and no parse / stringify round-trip happens on the migration
 *     path.
 */
import { type SensitiveConfigEntry, adminCryptoRoutes } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import { listSensitiveConfigKeys } from 'src/models/config-sensitive';
import { encrypt, isEncrypted, isEncryptionConfigured } from 'src/util/crypto';

import type { CrowiHonoBindings } from '../app';
import { createJwtAdminRequired } from '../middleware/admin';
import { INTERNAL_ERROR_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:adminCrypto');

/**
 * 503 envelope returned when `CROWI_ENCRYPTION_KEY` is not configured.
 * Body literal preserved verbatim from the ts-rest era — clients (the
 * admin dashboard `crypto-status-card`) match on the `code` field.
 */
const ENCRYPTION_NOT_CONFIGURED_BODY = {
  error: {
    code: 'ENCRYPTION_NOT_CONFIGURED' as const,
    message: 'CROWI_ENCRYPTION_KEY is not set on the server.' as const,
  },
};

export const registerAdminCryptoRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const Config = crowi.model('Config');

  // `/admin/crypto/*` is admin-only — install `createJwtAdminRequired`
  // on the two literal paths. The middleware chains `jwtAuth` so
  // `c.get('user')` is populated before the admin gate runs. No other
  // handler owns these paths, so there is no double-apply risk.
  app.use('/admin/crypto/status', createJwtAdminRequired(crowi));
  app.use('/admin/crypto/reencrypt', createJwtAdminRequired(crowi));

  return app
    .openapi(adminCryptoRoutes.getCryptoStatusRoute, async (c) => {
      debug('getCryptoStatus called');

      try {
        const registry = listSensitiveConfigKeys();

        const docs = (await Config.find({
          $or: registry.map(({ ns, key }) => ({ ns, key })),
        })
          .lean()
          .exec()) as Array<{ ns: string; key: string; value: string }>;

        const docByCompound = new Map<string, { value: string }>();
        for (const doc of docs) {
          docByCompound.set(`${doc.ns}:${doc.key}`, { value: doc.value });
        }

        let unencryptedCount = 0;
        let encryptedCount = 0;
        const entries: SensitiveConfigEntry[] = registry.map(({ ns, key }) => {
          const stored = docByCompound.get(`${ns}:${key}`);
          if (!stored) {
            return { ns, key, present: false, encrypted: false };
          }
          const encrypted = isEncrypted(stored.value);
          if (encrypted) encryptedCount += 1;
          else unencryptedCount += 1;
          return { ns, key, present: true, encrypted };
        });

        return c.json(
          {
            encryptionConfigured: isEncryptionConfigured(),
            unencryptedCount,
            encryptedCount,
            entries,
          },
          200,
        );
      } catch (err) {
        debug('Error in getCryptoStatus:', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(adminCryptoRoutes.reencryptAllRoute, async (c) => {
      debug('reencryptAll called');

      if (!isEncryptionConfigured()) {
        return c.json(ENCRYPTION_NOT_CONFIGURED_BODY, 503);
      }

      try {
        const registry = listSensitiveConfigKeys();

        const docs = (await Config.find({
          $or: registry.map(({ ns, key }) => ({ ns, key })),
        })
          .lean()
          .exec()) as Array<{ ns: string; key: string; value: string }>;

        const presentByCompound = new Map<string, string>();
        for (const doc of docs) presentByCompound.set(`${doc.ns}:${doc.key}`, doc.value);

        let rewritten = 0;
        let alreadyEncrypted = 0;
        let missing = 0;

        for (const { ns, key } of registry) {
          const value = presentByCompound.get(`${ns}:${key}`);
          if (value === undefined) {
            missing += 1;
            continue;
          }
          if (isEncrypted(value)) {
            alreadyEncrypted += 1;
            continue;
          }
          const next = encrypt(value);
          await Config.findOneAndUpdate({ ns, key }, { ns, key, value: next }, { upsert: true }).exec();
          debug('re-encrypted %s:%s', ns, key);
          rewritten += 1;
        }

        return c.json({ rewritten, alreadyEncrypted, missing }, 200);
      } catch (err) {
        debug('Error in reencryptAll:', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    });
};
