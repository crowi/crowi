# @crowi/plugin-storage-gcs

Native Google Cloud Storage driver for Crowi 2.0. Stores page attachments
and profile pictures in a GCS bucket. Prefers Application Default
Credentials (ADC) — the environment's own service account, Workload
Identity Federation, or attached-service-account credentials — with an
encrypted inline service-account key JSON as an explicit fallback.

## Install

The **full Crowi runner** (`apps/crowi-runner`, the source of the official
"full" Docker image) already bundles this plugin — it's declared as a
`dependencies` entry and listed in `crowi.config.json:plugins`. On the full
runner there is no install step: enabling GCS is just setting
`storage.driver: "gcs"` and filling in the connection (below).

For a **custom runner project** (your own `package.json` + `crowi.config.json`
— see `@crowi/runner-app`'s README, `apps/crowi-runner`, for the shape a
runner project takes), install the plugin as a dependency **of that runner
project**, not of `@crowi/api`:

```bash
# from the runner project's own directory
npm install @crowi/plugin-storage-gcs

# or, if the runner is itself a workspace member of a pnpm monorepo:
pnpm --filter <your-runner-package> add @crowi/plugin-storage-gcs
```

then list it in that runner's `crowi.config.json:plugins`:

```jsonc
{
  "plugins": ["@crowi/plugin-storage-gcs"]
}
```

`@crowi/runner` resolves plugin packages via `createRequire(<runner's
package.json>)` against the runner project's own `node_modules` — the
dependency has to live in the runner's `package.json`, which is why
installing it into `@crowi/api` (or anywhere else) does not make it
loadable.

## Configure

### 1. Activate the driver in `crowi.config.json`

```jsonc
{
  "plugins": ["@crowi/plugin-storage-gcs"],
  "storage": { "driver": "gcs" }
}
```

A server restart is required when `storage.driver` changes — Crowi reads
this file once at boot. Changing the *active* GCS connection's
bucket/prefix/credentials in a multi-instance deployment also requires a
full stop of every replica and a restart — there is no supported online
path (see "Migrate existing files" below).

### 2. Fill in the connection in the admin UI

Open `/admin/plugins` → **Google Cloud Storage**:

| Field | Required | Notes |
|---|---|---|
| **GCS bucket** | Yes | Existing private bucket name. Crowi does not create buckets. |
| **Object prefix** | No | Prepended to every Crowi object key (`prod/wiki` + `attachment/p/k.png` → `prod/wiki/attachment/p/k.png`). Leading/trailing `/` are stripped automatically; `.`/`..`/empty segments are rejected. |
| **Google Cloud project ID** | No | Explicit project ID. Leave blank to use ADC's own project or the inline key's `project_id`. An explicit value always wins over the inline key's project. |
| **Service account key JSON** | No | Encrypted at rest. Leave blank to use ADC. When set, it must be a full service-account key JSON (`type: "service_account"`, `project_id`, `client_email`, `private_key` as a PEM block) — anything else is rejected with a 422 before it is ever saved. |

The four fields are saved together as **one encrypted document** (an
atomic config group), not as four independent rows — a partial write never
happens. Leaving **Service account key JSON** blank on a later save does
not clear a previously-saved key; the admin UI never re-sends an unchanged
secret, and the API never overwrites a stored secret with an omitted field.

Leaving **Service account key JSON** blank tells the SDK to use
[Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)
— the environment's attached service account (GCE/GKE/Cloud Run), a
Workload Identity Federation credential, or `gcloud auth
application-default login` locally. This is the recommended setup when
running on Google Cloud: let the platform vend short-lived credentials,
don't store a long-lived key in Mongo.

### 3. Migrate existing files (if switching from `local` or `s3`)

There is no live/coordinated migration — this is a **full-stop** copy only:

1. Save a valid GCS connection through the admin UI while the *old* driver
   (`local`/`s3`) is still active — `storage.driver` does not change yet.
2. Stop every API replica and every storage-mutating CLI/background worker.
   Confirm zero in-flight attachment upload/delete, profile image upload,
   page hard delete, and derivative generation/rebuild.
3. Run the copy against the stopped system:
   ```bash
   crowi-admin rebuild storage copy --from local --to gcs --dry-run   # preview
   crowi-admin rebuild storage copy --from local --to gcs             # actual copy
   ```
   The CLI walks the `Attachment` collection and `User.image` URLs,
   streaming each key from the source driver into GCS's `put`. Failures
   are logged and skipped; re-running is safe (GCS `put` is overwrite-by-key).
   Confirm the summary reports `failed: 0`, then read-verify (a reverse
   copy into a disposable scratch destination is the cheapest exhaustive
   check — see `docs/manual-verification/storage-gcs-provider.md`).
4. Flip `storage.driver` to `gcs` and restart every replica.
5. Spot-check upload/delete/profile image/proxy delivery, then re-enable
   background workers. Keep the old storage intact for a rollback window.

See `docs/manual-verification/storage-gcs-provider.md` (repo root) for the
full checklist, including why this is full-stop-only and how read
verification works.

## Required IAM permissions

The driver calls three GCS object operations and one signing operation:

- `storage.objects.create` — `put`
- `storage.objects.get` — `get` (download), and V4 signed-URL generation
  when using an ADC identity (IAM Credentials `signBlob`, see below)
- `storage.objects.delete` — `delete`

A minimal custom role built from exactly these three permissions is
sufficient — the driver never lists objects. The predefined **Storage
Object User** role (`roles/storage.objectUser`) also works and additionally
bundles `storage.objects.list`, which the driver doesn't call but which
comes along with the role at no extra grant. `storage.buckets.*`
permissions are **not** needed — Crowi never creates, lists, or configures
buckets.

### Signed URLs (V4) — a separate permission

`signedUrl()` always works when the connection uses an **inline
service-account key**: the private key signs locally, no extra API call or
IAM permission needed.

When the connection uses **ADC** instead (ADC has no private key to sign
with locally), V4 signing needs the
[IAM Credentials `signBlob`](https://cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/signBlob)
permission (`roles/iam.serviceAccountTokenCreator` on the identity itself,
or an explicit `iam.serviceAccounts.signBlob` grant) — this is separate
from the object CRUD permissions above and easy to miss. Crowi's own
attachment routes (`/api/attachments/:id`, `/original`, `/download`) do
**not** call `signedUrl()` today — they always proxy through the API — so
missing `signBlob` does not affect normal upload/download. It only matters
for a future direct-delivery caller.

## What does NOT need to be configured

- **Bucket-level IAM conditions / uniform bucket-level access / Public
  Access Prevention / CMEK / lifecycle policy / retention / versioning** —
  none of these are managed by Crowi. Configure them (or not) directly on
  the bucket; the driver only reads/writes/deletes objects.
- **CORS** — attachments are served through the Crowi API proxy, not
  fetched directly from GCS by the browser, so no CORS rule on the bucket
  is required.

## Object layout

The driver maps a Crowi logical key to a physical GCS object name as
`<normalized-prefix>/<key>` (or just `<key>` when the prefix is empty) —
the key itself is never trimmed, URL-encoded, or path-normalized. The keys
Crowi uses are:

```
attachment/<pageId>/<fileId>/<original-filename>
user/<userId>.<ext>
```

This matches the v1.x layout (with an empty prefix), so operators
upgrading from Crowi 1.x, or migrating from `local`/`s3`, can point
**GCS bucket** at their existing bucket and files round-trip without
migration. Setting a non-empty prefix isolates Crowi's objects under a
sub-path of the bucket by naming convention only — it is **not** an IAM
boundary; anyone with bucket-level access can still read outside the
prefix.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `bucket=<unset>` in the boot log | Set **GCS bucket** under `/admin/plugins` for `@crowi/plugin-storage-gcs`. |
| `403 Forbidden` on upload/download/delete | Grant `storage.objects.{create,get,delete}` (or `roles/storage.objectUser`) to the identity Crowi runs as (ADC) or the inline key's service account. |
| `403`/signing failure from `signedUrl()` only | ADC identity is missing IAM Credentials `signBlob` (see above) — object CRUD can still work fine even though signing fails. |
| Attachment displays as a placeholder / strict download returns `FILE_MISSING`, but the file "should" be there | GCS 404s for *any* reason (deleted object, deleted bucket, revoked permission, wrong prefix) are indistinguishable from a genuinely missing object — Crowi cannot tell them apart from the driver's response alone. Check bucket existence and IAM directly. This is an accepted limitation shared with `local`/`s3`; save-time connection verification (a separate feature) is what catches misconfiguration early. |
| `Unable to detect a Project Id in the current environment` | ADC has no project and none was set. Set **Google Cloud project ID** explicitly, or ensure ADC's own environment (`gcloud config set project`, GCE/GKE metadata, etc.) provides one. |
| `422 PLUGIN_CONFIG_VALIDATION_FAILED` on save | The submitted **Service account key JSON** failed validation (invalid JSON, wrong `type`, a missing `project_id`/`client_email`/`private_key`, or a malformed PEM block) — the response's `issues` array lists every failing field; nothing was saved. |

## Emulator (development/testing only)

An opt-in `fsouza/fake-gcs-server` service (`docker-compose.yml`'s
`crowi-test-gcs`, profile `gcs-test`) backs this package's integration
tests. It is **not** started by a normal `docker compose up -d` or in
normal CI.

Against this real GCS-JSON-API-compatible server, the opt-in suite
(`packages/api/src/plugin/storage-gcs.emulator.test.ts`) verifies:

- Buffer and Readable upload/download round-trips (bytes match).
- Prefix mapping to the correct physical object name.
- Idempotent delete (an existing object succeeds; an already-absent one is
  a no-op, not a rejection).
- Missing-object `get()` converting to the `code: 'ENOENT'` shape that the
  real, unmodified `isMissingFileError` classifies as missing.
- A local-to-GCS `runStorageCopy` round-trip.

It is **not** an oracle for ADC discovery, real IAM, or `signBlob` — see
`docs/manual-verification/storage-gcs-provider.md` for what still needs a
real bucket.

```bash
docker compose --profile gcs-test up -d crowi-test-gcs
STORAGE_EMULATOR_HOST=http://127.0.0.1:4443 pnpm --filter @crowi/api test -- --runInBand src/plugin/storage-gcs.emulator.test.ts
docker compose --profile gcs-test stop crowi-test-gcs
```

## See also

- [`@crowi/plugin-storage-aws-s3`](../plugin-storage-aws-s3) — the S3
  driver, same `StorageDriver` contract.
- [`@crowi/plugin-storage-local`](../plugin-storage-local) — the
  default-on local filesystem driver.
- RFC-0001 §"Storage (S3)" for the general plugin-architecture / migration
  story from Crowi 1.x (GCS follows the same shape).
