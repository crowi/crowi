# @crowi/plugin-aws

Shared AWS credentials base plugin. Holds `region` / `accessKeyId` /
`secretAccessKey` once, so any number of AWS-using plugins
(`@crowi/plugin-storage-aws-s3`, future `@crowi/plugin-mail-aws-ses`, etc)
can read the same configuration without operators duplicating it.

This plugin **does not register any driver** on its own — it's a
config-holder. It auto-loads when any AWS plugin lists it under
`requires`, so operators do not need to add it to
`crowi.config.json:plugins` themselves.

## Configure

Open `/admin/plugins`, select `@crowi/plugin-aws`, and fill in:

| Field | Required? | Notes |
|---|---|---|
| `region` | Recommended | e.g. `ap-northeast-1`, `us-east-1`. Validated against the `<area>-<sub>-<num>` shape. Empty string falls back to the SDK default region resolution. |
| `accessKeyId` | Optional | Long-lived IAM access key. Leave blank to use the SDK's default credential chain (see below). |
| `secretAccessKey` | Optional | Pairs with `accessKeyId`. Encrypted at rest with `CROWI_ENCRYPTION_KEY`. |

### When to leave the keys blank

Both `accessKeyId` and `secretAccessKey` empty → the AWS SDK falls back
to its [default credential provider chain](https://docs.aws.amazon.com/sdkref/latest/guide/standardized-credentials.html#credentialProviderChain),
in this order:

1. Environment variables (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
   `AWS_SESSION_TOKEN`)
2. Shared credentials file (`~/.aws/credentials`)
3. EC2 / ECS / EKS instance / task / pod identity
4. Other SDK-managed sources (SSO, web identity, etc.)

For production on AWS, **leave the keys blank and use an IAM role**.
You get short-lived credentials rotated by AWS without operators ever
holding a long-lived secret.

## What this plugin does NOT do

- **Does not register a storage / search / auth / notifier driver.** Its
  only job is to publish a typed config to dependent plugins via
  `ctx.dependencyConfig<AwsConfig>('@crowi/plugin-aws')`.
- **Does not pre-validate credentials.** A bad key shows up at the first
  AWS API call from the dependent plugin (e.g. an S3 `PutObject`),
  not at boot.
- **Does not configure per-service knobs** (S3 bucket, SES verified
  identity, etc). Those live in the consuming plugin's own config.

## See also

- [`@crowi/plugin-storage-aws-s3`](../plugin-storage-aws-s3) — S3 storage
  driver. Required IAM permissions are documented there.
