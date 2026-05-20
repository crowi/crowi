import { Readable } from 'node:stream';
import { z } from 'zod/v3';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AwsConfig } from '@crowi/plugin-aws';
import type { CrowiPlugin, PluginContext, StorageDriver } from '@crowi/plugin-api';

const S3StorageConfigSchema = z
  .object({
    bucket: z.string().default(''),
  })
  .strict();

type S3StorageConfig = z.infer<typeof S3StorageConfigSchema>;

export interface S3DriverState {
  client: S3Client;
  bucket: string;
}

/**
 * Module-scope state ref. `registerStorage` initialises it from the
 * boot-time config; the driver methods snapshot from it on every call;
 * `reconfigure` mutates its fields in place when admin saves new
 * values. The single-instance assumption is fine — the plugin
 * registers exactly one `'s3'` driver, owned by this module.
 */
const state: S3DriverState = {
  client: new S3Client({}),
  bucket: '',
};

const plugin: CrowiPlugin = {
  name: '@crowi/plugin-storage-aws-s3',
  version: '0.1.0-dev',
  requires: ['@crowi/plugin-aws'],
  configSchema: S3StorageConfigSchema,
  adminPlacement: {
    label: 'AWS S3',
    icon: 'cloud',
    // section omitted: derived from registerStorage → 'storage'
  },

  registerStorage: (registry, ctx) => {
    applyConfigToState(ctx, state);
    registry.register('s3', createS3Driver(state));
    ctx.log.debug('registered s3 storage driver (bucket=%s)', state.bucket || '<unset>');
  },

  reconfigure: (ctx) => {
    applyConfigToState(ctx, state);
    ctx.log.debug('reconfigured s3 storage driver (bucket=%s)', state.bucket || '<unset>');
  },
};

export default plugin;

function applyConfigToState(ctx: PluginContext, target: S3DriverState): void {
  const own = ctx.config<S3StorageConfig>();
  const aws = ctx.dependencyConfig<AwsConfig>('@crowi/plugin-aws');
  target.client = new S3Client({
    region: aws.region || undefined,
    credentials:
      aws.accessKeyId && aws.secretAccessKey
        ? {
            accessKeyId: aws.accessKeyId,
            secretAccessKey: aws.secretAccessKey,
          }
        : undefined,
  });
  target.bucket = own.bucket;
}

/**
 * Build the storage driver. Methods read `driverState` *once at the
 * top* — a snapshot — so a `reconfigure` running concurrently with an
 * inflight `put` / `get` cannot swap the client mid-call. The next
 * call sees the new client/bucket.
 */
export function createS3Driver(driverState: S3DriverState): StorageDriver {
  return {
    async put(key, body, meta) {
      const { client, bucket } = driverState;
      requireBucket(bucket);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body as Buffer | Readable,
          ContentType: meta.contentType,
        }),
      );
      return { key };
    },

    async get(key) {
      const { client, bucket } = driverState;
      requireBucket(bucket);
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = response.Body;
      if (!body) {
        throw new Error(`S3 returned empty body for key '${key}'`);
      }
      return body as Readable;
    },

    async delete(key) {
      const { client, bucket } = driverState;
      requireBucket(bucket);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async signedUrl(key, expiresInSec) {
      const { client, bucket } = driverState;
      requireBucket(bucket);
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresInSec });
    },
  };
}

function requireBucket(bucket: string): void {
  if (!bucket) {
    throw new Error('@crowi/plugin-storage-aws-s3: bucket is not configured.');
  }
}
