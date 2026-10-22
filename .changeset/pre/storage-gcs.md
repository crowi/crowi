---
"@crowi/plugin-storage-gcs": minor
"@crowi/api": patch
---

Added a native Google Cloud Storage driver plugin (`@crowi/plugin-storage-gcs`, driver name `gcs`) so operators can store page attachments and profile pictures in a GCS bucket, using Application Default Credentials by default with an encrypted inline service-account key as a fallback.

- Bucket, optional object prefix, optional project ID, and optional service-account key JSON are configured from `/admin/plugins`; the four fields save together as one encrypted document and hot-reconfigure without a restart while `gcs` is not yet the active driver.
- Missing-object behavior matches the existing `local`/`s3` drivers exactly (same placeholder/`FILE_MISSING`/derivative-fallback UX), and V4 signed URLs are supported for future direct-delivery use without changing how attachments are served today (still proxied through the Crowi API).
- The full runner and full Docker image now bundle this plugin (the active driver stays `s3` unless an operator explicitly switches `storage.driver` to `gcs`), and `crowi-admin rebuild storage copy` supports migrating existing files from `local`/`s3` to GCS via a full-stop copy procedure documented in the operations guide.
