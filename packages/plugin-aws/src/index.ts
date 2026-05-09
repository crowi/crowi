import { z } from 'zod';
import type { CrowiPlugin } from '@crowi/plugin-api';

/**
 * Shared AWS configuration. Storage / mail / etc. plugins list this in
 * `requires` and read it via `ctx.dependencyConfig('@crowi/plugin-aws')`,
 * so operators don't have to add it to `crowi.config.json:plugins`
 * themselves and the admin form section is rendered once regardless of
 * how many AWS-using plugins are installed.
 */
export const AwsConfigSchema = z
  .object({
    region: z
      .string()
      .trim()
      .refine((v) => v === '' || /^[a-z]+(-[a-z]+)?-[a-z]+-\d+$/.test(v), {
        message: 'Must be a valid AWS region name (e.g. ap-northeast-1)',
      })
      .default(''),
    /**
     * Leave both accessKeyId and secretAccessKey empty to fall back to
     * the Node SDK's default credential chain (IAM role / env vars /
     * shared credentials file).
     */
    accessKeyId: z
      .string()
      .trim()
      .refine((v) => v === '' || /^[\dA-Za-z]+$/.test(v), {
        message: 'Access Key ID must be alphanumeric',
      })
      .default(''),
    secretAccessKey: z.string().describe('@sensitive AWS secret access key').default(''),
  })
  .strict();

export type AwsConfig = z.infer<typeof AwsConfigSchema>;

const plugin: CrowiPlugin = {
  name: '@crowi/plugin-aws',
  version: '0.1.0-dev',
  configSchema: AwsConfigSchema,
  adminPlacement: {
    section: 'shared',
    label: 'AWS',
    icon: 'cloud',
  },
};

export default plugin;
