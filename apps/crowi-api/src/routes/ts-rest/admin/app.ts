import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract } from '@crowi/api-contract';
import { Express, Router } from 'express';
import Crowi from 'src/crowi';
import { registrationMode } from 'src/models/config';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:admin:app');

/**
 * Coerce arbitrary stored config values to the typed shape the API exposes.
 * The Config collection stores values as JSON-stringified blobs; while we
 * already pass them through `loadAllConfig`'s decode, mongoose-side defaults
 * may still leave us with `undefined`/`null` for keys the operator never set.
 */
const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
const asBoolean = (value: unknown): boolean => value === true;

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();
  const Config = crowi.model('Config');

  const router_ = s.router(apiContract.admin.app, {
    /**
     * Returns the current `app:*` and `upload:aws:*` slice. The secret access
     * key is masked — only `{ hasValue }` is reported, never the plaintext.
     * `accessKeyId` is returned plain to match legacy display behaviour.
     */
    getAppSettings: async () => {
      const config = crowi.getConfig();
      const crowiNs = (config.crowi ?? {}) as Record<string, unknown>;
      const isUploadable = Config.isUploadable(config);

      const secretAccessKey = asString(crowiNs['upload:aws:secretAccessKey']);

      return {
        status: 200 as const,
        body: {
          app: {
            title: asString(crowiNs['app:title']),
            confidential: asString(crowiNs['app:confidential']),
            fileUpload: asBoolean(crowiNs['app:fileUpload']),
            externalShare: asBoolean(crowiNs['app:externalShare']),
          },
          upload: {
            aws: {
              region: asString(crowiNs['upload:aws:region']),
              bucket: asString(crowiNs['upload:aws:bucket']),
              accessKeyId: asString(crowiNs['upload:aws:accessKeyId']),
              secretAccessKey: { hasValue: secretAccessKey.length > 0 },
            },
          },
          isUploadable,
          registrationMode,
        },
      };
    },

    /**
     * Partial update of `app:*` and `upload:aws:*`. We translate the section
     * shape to the flat `crowi` namespace keys the legacy controller used so
     * `configService.saveConfig` does the encryption / persistence in the
     * same way regardless of whether the request came from this route or the
     * legacy POST endpoint.
     *
     * `secretAccessKey` semantics:
     * - omitted   → not added to the payload, value stays untouched.
     * - empty ''  → forwarded as '' so the row is overwritten with the empty
     *               value. This keeps the "explicitly clear" path open.
     * - non-empty → forwarded; auto-encryption kicks in via `isSensitiveConfig`.
     */
    updateAppSettings: async ({ body }) => {
      const updates: Record<string, unknown> = {};

      if (body.app) {
        if (body.app.title !== undefined) updates['app:title'] = body.app.title;
        if (body.app.confidential !== undefined) updates['app:confidential'] = body.app.confidential;
        if (body.app.fileUpload !== undefined) updates['app:fileUpload'] = body.app.fileUpload;
      }

      if (body.upload?.aws) {
        const { region, bucket, accessKeyId, secretAccessKey } = body.upload.aws;
        if (region !== undefined) updates['upload:aws:region'] = region;
        if (bucket !== undefined) updates['upload:aws:bucket'] = bucket;
        if (accessKeyId !== undefined) updates['upload:aws:accessKeyId'] = accessKeyId;
        if (secretAccessKey !== undefined) updates['upload:aws:secretAccessKey'] = secretAccessKey;
      }

      if (Object.keys(updates).length > 0) {
        debug('updateAppSettings keys=%o', Object.keys(updates));
        await crowi.getConfigService().saveConfig('crowi', updates);
      }

      return { status: 200 as const, body: { ok: true as const } };
    },
  });

  createExpressEndpoints(apiContract.admin.app, router_, router);
  return router;
};
