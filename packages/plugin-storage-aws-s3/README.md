# @crowi/plugin-storage-aws-s3

AWS S3 storage driver for Crowi 2.0. Stores page attachments and profile
pictures in an S3 bucket. Pairs with [`@crowi/plugin-aws`](../plugin-aws)
for shared region / access-key configuration.

## Install

```bash
crowi-admin plugin add @crowi/plugin-storage-aws-s3
```

(or, in dev: `pnpm --filter @crowi/api add -D @crowi/plugin-storage-aws-s3`)

The plugin auto-loads its dependency `@crowi/plugin-aws`. You don't need
to add it explicitly.

## Configure

### 1. Activate the driver in `crowi.config.json`

```jsonc
{
  "plugins": ["@crowi/plugin-storage-aws-s3"],
  "storage": { "driver": "s3" }
}
```

A server restart is required when `storage.driver` changes — Crowi reads
this file once at boot.

### 2. Fill in credentials in the admin UI

Open `/admin/plugins`:

- **`@crowi/plugin-aws`** — `region`, `accessKeyId`, `secretAccessKey`
  (the secret is encrypted at rest with `CROWI_ENCRYPTION_KEY`)
- **`@crowi/plugin-storage-aws-s3`** — `bucket`

Leaving `accessKeyId` and `secretAccessKey` blank tells the SDK to use
its [default credential chain](https://docs.aws.amazon.com/sdkref/latest/guide/standardized-credentials.html#credentialProviderChain)
(env vars, shared credentials file, EC2 instance role, ECS task role,
EKS pod identity, etc). This is the recommended setup when running on
AWS — let the platform vend short-lived credentials, don't store
long-lived keys in Mongo.

### 3. Migrate existing files (if switching from `local`)

```bash
crowi-admin storage copy --from local --to s3 --dry-run    # preview
crowi-admin storage copy --from local --to s3              # actual copy
```

The CLI walks the `Attachment` collection and `User.image` URLs, copying
every key from one driver to the other. Failures are logged and skipped;
re-running is safe (S3 `PutObject` is overwrite-by-key).

## Required IAM permissions

Three S3 operations are called by the driver: `PutObject`, `GetObject`,
`DeleteObject`. Signed URLs are produced locally with the SDK presigner,
which signs a `GetObjectCommand` — so the **client** consuming the signed
URL needs `GetObject` (which the driver's IAM principal already has).
`ListBucket` is **not** needed.

A minimal IAM policy you can attach to the IAM user / role Crowi runs as:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CrowiStorageObjects",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::YOUR_BUCKET_NAME/*"
    }
  ]
}
```

The same policy is shipped at [`examples/iam-policy.json`](examples/iam-policy.json)
so you can apply it directly:

```bash
aws iam create-policy \
  --policy-name CrowiStorage \
  --policy-document file://examples/iam-policy.json
```

A variant with `s3:ListBucket` enabled is at
[`examples/iam-policy-with-list.json`](examples/iam-policy-with-list.json) —
not needed today, but reserved for a future `crowi-admin storage list` /
`storage diff` command that would enumerate keys server-side.

## What does NOT need to be configured

- **Bucket policy** — IAM policy is enough for normal single-account
  setups. Use a bucket policy only if you need cross-account access,
  SSE enforcement, or public-read overrides — Crowi neither requires
  nor opposes those, but they're environment-specific and out of scope
  for this plugin's docs.
- **CORS** — Crowi serves signed URLs directly via `<img>` / download
  links, which are simple `GET` requests with no preflight. CORS rules
  on the bucket are unnecessary unless you add a future feature that
  uploads from the browser straight to S3 (presigned `PUT`).
- **SSE-S3** — works out of the box if the bucket has default
  encryption enabled. The driver does not set `ServerSideEncryption`
  explicitly; let the bucket's default policy decide.

## Object layout

The driver passes storage keys through to S3 verbatim. The keys Crowi
uses are:

```
attachment/<pageId>/<fileId>/<original-filename>
user/<userId>.<ext>
```

This matches the v1.x layout, so operators upgrading from Crowi 1.x can
point `bucket` at their existing bucket and files round-trip without
migration.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `bucket=<unset>` in the boot log | Set `bucket` under `/admin/plugins` for `@crowi/plugin-storage-aws-s3`. |
| `region=<default>` in the boot log | Set `region` under `/admin/plugins` for `@crowi/plugin-aws` (e.g. `ap-northeast-1`). |
| `403 Forbidden` on PUT | Check the IAM policy — `s3:PutObject` against `arn:aws:s3:::<bucket>/*`. |
| `403 Forbidden` on GET via signed URL | Same; the signing principal needs `s3:GetObject`. |
| `301 PermanentRedirect` | `region` mismatch. The bucket lives in a different region than the SDK is configured to talk to. |
| Long-lived secret keys committed somewhere | Don't. Use IAM roles on EC2 / ECS / EKS, leave `accessKeyId` blank. |

## See also

- [`@crowi/plugin-aws`](../plugin-aws) — shared AWS credential plugin (auto-loaded as a dependency).
- [`@crowi/plugin-storage-local`](../plugin-storage-local) — the default-on local filesystem driver.
- RFC-0001 §"Storage (S3)" for the migration story from Crowi 1.x.
