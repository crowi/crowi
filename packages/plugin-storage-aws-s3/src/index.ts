import { Readable } from 'node:stream';
import { z } from 'zod';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AwsConfig } from '@crowi/plugin-aws';
import type { CrowiPlugin, StorageDriver } from '@crowi/plugin-api';

const S3StorageConfigSchema = z
  .object({
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
 * If `accessKeyId` and `secretAccessKey` are both empty, the AWS SDK
 * falls back to its default credential chain (IAM role / env vars /
 * shared file).
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
