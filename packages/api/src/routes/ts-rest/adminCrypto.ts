import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract, type SensitiveConfigEntry } from '@crowi/api-contract';
import { Express, Router } from 'express';
import Crowi from 'src/crowi';
import { encrypt, isEncrypted, isEncryptionConfigured } from 'src/util/crypto';
import { listSensitiveConfigKeys } from 'src/models/config-sensitive';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:adminCrypto');

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();
  const Config = crowi.model('Config');

  const router_ = s.router(apiContract.adminCrypto, {
    /**
     * Reads the raw `value` column rather than going through loadAllConfig's
     * decrypt path, so encrypted vs legacy plaintext can be distinguished by
     * the `enc:v1:` prefix.
     */
    getCryptoStatus: async () => {
      const registry = listSensitiveConfigKeys();

      const docs = await Config.find({
        $or: registry.map(({ ns, key }) => ({ ns, key })),
      })
        .lean()
        .exec();

      const docByCompound = new Map<string, { value: string }>();
      for (const doc of docs as Array<{ ns: string; key: string; value: string }>) {
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

      return {
        status: 200 as const,
        body: {
          encryptionConfigured: isEncryptionConfigured(),
          unencryptedCount,
          encryptedCount,
          entries,
        },
      };
    },

    /**
     * The raw value column is JSON-stringified already (= loadAllConfig's
     * expected shape), so we wrap it verbatim with encrypt() — no parse /
     * stringify round-trip on the migration path.
     */
    reencryptAll: async () => {
      if (!isEncryptionConfigured()) {
        return {
          status: 503 as const,
          body: {
            error: {
              code: 'ENCRYPTION_NOT_CONFIGURED' as const,
              message: 'CROWI_ENCRYPTION_KEY is not set on the server.',
            },
          },
        };
      }

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

      return {
        status: 200 as const,
        body: { rewritten, alreadyEncrypted, missing },
      };
    },
  });

  createExpressEndpoints(apiContract.adminCrypto, router_, router);
  return router;
};
