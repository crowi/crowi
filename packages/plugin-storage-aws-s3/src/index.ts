import { Readable } from 'node:stream';
import { z } from 'zod';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AwsConfig } from '@crowi/plugin-aws';
import type { CrowiPlugin, StorageDriver } from '@crowi/plugin-api';

/**
 * AWS S3 storage driver. Depends on `@crowi/plugin-aws` for shared
 * credentials (region / accessKeyId / secretAccessKey) — operators
 * configure those once via the @crowi/plugin-aws admin section and
 * S3 + future SES + … all pick them up.
 *
 * Object keys are passed through verbatim to S3, preserving the
 * v1.x naming convention. Operators upgrading from v1.x point
 * `bucket` at their existing bucket and files round-trip without
 * migration.
 */

const S3StorageConfigSchema = z
  .object({
    /** S3 bucket name. Required to be non-empty for the driver to work. */
    bucket: z.string().default(''),
  })
  .strict();

type S3StorageConfig = z.infer<typeof S3StorageConfigSchema>;

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
    const own = ctx.config<S3StorageConfig>();
    const aws = ctx.dependencyConfig<AwsConfig>('@crowi/plugin-aws');
    const driver = createS3Driver({ ...aws, bucket: own.bucket });
    registry.register('s3', driver);
    ctx.log.debug('registered s3 storage driver (bucket=%s, region=%s)', own.bucket || '<unset>', aws.region || '<default>');
  },
};

export default plugin;

interface S3DriverConfig extends AwsConfig {
  bucket: string;
}

/**
 * Build the StorageDriver. Exported separately so the test suite can
 * exercise the implementation without going through PluginManager.
 *
 * If `accessKeyId` and `secretAccessKey` are both empty, the AWS SDK
 * falls back to its default credential chain (IAM role, env vars,
 * shared file). Operators running on EC2 / ECS / Fargate can use IAM
 * roles by leaving the key fields blank.
 */
export function createS3Driver(config: S3DriverConfig): StorageDriver {
  const client = new S3Client({
    region: config.region || undefined,
    credentials:
      config.accessKeyId && config.secretAccessKey
        ? {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          }
        : undefined,
  });

  const requireBucket = (): string => {
    if (!config.bucket) {
      throw new Error('@crowi/plugin-storage-aws-s3: bucket is not configured.');
    }
    return config.bucket;
  };

  return {
    async put(key, body, meta) {
      const Bucket = requireBucket();
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: body as Buffer | Readable,
          ContentType: meta.contentType,
        }),
      );
      return { key };
    },

    async get(key) {
      const Bucket = requireBucket();
      const response = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      const body = response.Body;
      if (!body) {
        throw new Error(`S3 returned empty body for key '${key}'`);
      }
      // The AWS SDK's `Body` is a Readable on Node, but typed as a
      // wider union. Cast to Readable for the contract surface.
      return body as Readable;
    },

    async delete(key) {
      const Bucket = requireBucket();
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },

    async signedUrl(key, expiresInSec) {
      const Bucket = requireBucket();
      return getSignedUrl(client, new GetObjectCommand({ Bucket, Key: key }), { expiresIn: expiresInSec });
    },
  };
}
