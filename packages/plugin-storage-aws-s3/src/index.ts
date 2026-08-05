import { Readable } from 'node:stream';
import { z } from 'zod/v3';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AwsConfig } from '@crowi/plugin-aws';
import type { CrowiPlugin, PluginContext, StateCell, StorageDriver } from '@crowi/plugin-api';

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
  // `bucket` defaults to '' (a valid Zod value) but every StorageDriver
  // method throws via `requireBucket()` below until it's set — see
  // feature-plugin-config-readiness. AWS credentials are intentionally
  // NOT declared here: an empty accessKeyId/secretAccessKey is a valid
  // "use the SDK default credential chain" configuration.
  readiness: {
    registry: 'storage',
    driver: 's3',
    requiredConfigFields: ['bucket'],
  },

  registerStorage: (registry, ctx) => {
    const cell = ctx.state<S3DriverState>(buildState(ctx));
    registry.register('s3', createS3Driver(cell));
    ctx.log.debug('registered s3 storage driver (bucket=%s)', cell.get().bucket || '<unset>');
  },

  reconfigure: (ctx) => {
    const next = buildState(ctx);
    const cell = ctx.state<S3DriverState>(next);
    cell.set(next, { dispose: (prev) => prev.client.destroy() });
    ctx.log.debug('reconfigured s3 storage driver (bucket=%s)', next.bucket || '<unset>');
  },
};

export default plugin;

function buildState(ctx: PluginContext): S3DriverState {
  const own = ctx.config<S3StorageConfig>();
  const aws = ctx.dependencyConfig<AwsConfig>('@crowi/plugin-aws');
  return {
    client: new S3Client({
      region: aws.region || undefined,
      credentials:
        aws.accessKeyId && aws.secretAccessKey
          ? {
              accessKeyId: aws.accessKeyId,
              secretAccessKey: aws.secretAccessKey,
            }
          : undefined,
    }),
    bucket: own.bucket,
  };
}

/**
 * Build the storage driver around a hot-reload {@link StateCell}. Each
 * method reads the cell through `withValue()`, which snapshots the
 * state for the duration of the call and protects it from being torn
 * down by a concurrent `reconfigure()` — the next call sees the new
 * client/bucket.
 */
export function createS3Driver(cell: StateCell<S3DriverState>): StorageDriver {
  return {
    async put(key, body, meta) {
      return cell.withValue(async ({ client, bucket }) => {
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
      });
    },

    async get(key) {
      return cell.withValue(async ({ client, bucket }) => {
        requireBucket(bucket);
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const body = response.Body;
        if (!body) {
          throw new Error(`S3 returned empty body for key '${key}'`);
        }
        return body as Readable;
      });
    },

    async delete(key) {
      return cell.withValue(async ({ client, bucket }) => {
        requireBucket(bucket);
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      });
    },

    async signedUrl(key, expiresInSec) {
      return cell.withValue(async ({ client, bucket }) => {
        requireBucket(bucket);
        return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresInSec });
      });
    },
  };
}

function requireBucket(bucket: string): void {
  if (!bucket) {
    throw new Error('@crowi/plugin-storage-aws-s3: bucket is not configured.');
  }
}
