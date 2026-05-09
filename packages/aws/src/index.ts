import { z } from 'zod';
import type { CrowiPlugin } from '@crowi/plugin-api';

/**
 * Shared AWS configuration. Plugins like `@crowi/storage-aws-s3` and
 * `@crowi/mail-aws-ses` depend on this plugin via `requires` and pull
 * `region` / `accessKeyId` / `secretAccessKey` through
 * `ctx.dependencyConfig('@crowi/aws')`.
 *
 * The plugin itself contributes nothing to any registry — it's a
 * config-holder. Auto-loaded transitively by the PluginManager when
 * any AWS service plugin lists it in `requires`, so operators do not
 * need to add `@crowi/aws` to `crowi.config.json:plugins` themselves.
 *
 * The corresponding admin form section is rendered exactly once, even
 * if multiple AWS-using plugins are installed.
 */
export const AwsConfigSchema = z
  .object({
    /** AWS region (e.g. `ap-northeast-1`). Empty string means unset. */
    region: z
      .string()
      .trim()
      .refine((v) => v === '' || /^[a-z]+(-[a-z]+)?-[a-z]+-\d+$/.test(v), {
        message: 'Must be a valid AWS region name (e.g. ap-northeast-1)',
      })
      .default(''),
    /**
     * AWS access key id. Empty string means unset — leave both
     * accessKeyId and secretAccessKey empty to fall back to the
     * Node SDK's default credential chain (IAM role, env vars,
     * shared credentials file, …).
     */
    accessKeyId: z
      .string()
      .trim()
      .refine((v) => v === '' || /^[\dA-Za-z]+$/.test(v), {
        message: 'Access Key ID must be alphanumeric',
      })
      .default(''),
    /** AWS secret access key. Empty string means unset. Encrypted at rest. */
    secretAccessKey: z.string().describe('@sensitive AWS secret access key').default(''),
  })
  .strict();

export type AwsConfig = z.infer<typeof AwsConfigSchema>;

const plugin: CrowiPlugin = {
  name: '@crowi/aws',
  version: '0.1.0-dev',
  configSchema: AwsConfigSchema,
  adminPlacement: {
    // Base plugin (config-only, no register*). Surfaced under the
    // sidebar's "shared services" section so operators find AWS
    // credentials in one place even when both S3 and SES depend on
    // them.
    section: 'shared',
    label: 'AWS',
    icon: 'cloud',
  },
  // No register* — config-only plugin. Downstream AWS plugins read
  // these values via ctx.dependencyConfig('@crowi/aws').
  // Legacy v1.x → v2.0 key migration is handled centrally by `crowi
  // migrate` in Step 9 of RFC-0001, not per-plugin onInstall.
};

export default plugin;
