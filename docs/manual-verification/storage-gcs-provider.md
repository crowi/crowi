# GCS storage provider — manual verification

`@crowi/plugin-storage-gcs`'s automated tests (mocked unit tests plus an
opt-in `fake-gcs-server` emulator suite) cover everything mockable, but a
handful of properties are release-manual gates outside that coverage: some
need a real bucket and real IAM permissions to check at all, others are
operator-procedure and code-design confirmations that deliberately stop
short of touching a live multi-replica deployment (there is no supported
recovery path if replicas diverge, so those are non-mutating by design,
not by omission). Run this checklist once before promoting the `gcs`
driver to `storage.driver` in any environment that matters, and again
after any credential or IAM change.

## ADC discovery and object permissions (real bucket required)

The opt-in `fake-gcs-server` emulator suite accepts anonymous
unauthenticated requests and never exercises Application Default
Credentials discovery or real IAM — none of the steps below can be
verified against it. Run these against a real GCS bucket in a real Google
Cloud project.

- [ ] With **Service account key JSON** left blank (ADC mode) and the
      driver's environment given a real credential source (an attached
      GCE/GKE/Cloud Run service account, a Workload Identity Federation
      binding, or a local `gcloud auth application-default login`),
      confirm boot succeeds and the driver activates without a
      `serviceAccountKey` validation error.
- [ ] Confirm the identity ADC resolves has, at minimum,
      `storage.objects.create`, `storage.objects.get`, and
      `storage.objects.delete` on the target bucket — a minimal custom role
      built from exactly these three is sufficient, since the driver never
      lists objects. The predefined **Storage Object User** role
      (`roles/storage.objectUser`) also works and additionally bundles
      `storage.objects.list` at no extra grant. No `storage.buckets.*`
      permission is needed — Crowi never creates/lists/configures buckets.
- [ ] Upload an attachment through the normal UI flow; confirm it lands at
      the expected physical name (`<prefix>/<key>` or `<key>` with no
      prefix) in the bucket.
- [ ] Download the same attachment through the normal UI flow (the proxy
      route, not a signed URL — see "Proxy delivery is unchanged" below);
      confirm the bytes match.
- [ ] Delete the attachment through the normal UI flow; confirm the object
      is gone from the bucket and the second delete (idempotent) does not
      error.
- [ ] With an explicit **Google Cloud project ID** set alongside an inline
      **Service account key JSON** whose own `project_id` differs, confirm
      the explicit field wins (check the constructed client's project via
      logs or by pointing at a bucket only reachable under the explicit
      project).

## V4 signed URL signing (`signBlob`) — a separate permission

`signedUrl()` is a distinct capability from object CRUD above, with a
different permission story depending on credential mode. Crowi's own
attachment routes do not call this today (see "Proxy delivery is
unchanged" below) — these steps are release-manual gates for a future
direct-delivery caller, not for normal upload/download.

- [ ] With an **inline service-account key** connection, confirm
      `signedUrl()` succeeds — the private key signs locally, no
      additional API call or IAM grant is needed beyond having a valid key.
- [ ] With an **ADC** connection, confirm `signedUrl()` either succeeds (if
      the resolved identity already has IAM Credentials `signBlob`,
      typically via `roles/iam.serviceAccountTokenCreator` on itself or an
      explicit `iam.serviceAccounts.signBlob` grant) or fails with a clear
      signing error — and confirm that failure does **not** affect normal
      attachment upload/download, which never call `signedUrl()`.
- [ ] Confirm a generated signed URL is rejected outside its TTL window
      (wait past expiry, or generate one with a short TTL) and accepted
      within it.

## Proxy delivery is unchanged

- [ ] Confirm `GET /api/attachments/:id` (and `/original`, `/download`,
      `by-key`) still stream through the Crowi API proxy with the `gcs`
      driver active — no redirect to a GCS URL, no `signedUrl()` call, even
      though the driver is capable of producing one. Automated coverage:
      `packages/api/src/hono/handlers/attachment.test.ts`.

## The emulator is not an IAM/ADC oracle

`fake-gcs-server`'s CRUD/prefix/missing-object coverage
(`packages/api/src/plugin/storage-gcs.emulator.test.ts`) proves the
driver's wire-level request/response handling against a real GCS-JSON-API
server. Specifically, it verifies:

- Buffer and Readable upload/download round-trips (bytes match).
- Prefix mapping to the correct physical object name.
- Idempotent delete (an existing object succeeds; an already-absent one is
  a no-op, not a rejection).
- Missing-object `get()` converting to the `code: 'ENOENT'` shape that the
  real, unmodified `isMissingFileError` classifies as missing.
- A local-to-GCS `runStorageCopy` round-trip.

It proves nothing about:

- ADC discovery (it accepts anonymous requests; no credential is ever
  resolved or checked).
- Real IAM permission enforcement (it does not model roles/bindings at
  all — every request succeeds regardless of "permission").
- `signBlob` / real V4 signing correctness (no query-param/signature
  validation happens against fake-gcs-server).
- Bucket-deletion or permission-revocation 404 misclassification in a real
  project (see "Bucket deletion / permission revocation look like a
  missing object" below — this can only be observed against a real
  bucket).

Passing the emulator suite is a necessary but not sufficient condition for
production readiness; the real-bucket checks above are what close that gap.

## Bucket deletion / permission revocation look like a missing object

This is an accepted limitation, not a bug to reproduce and fix — verify
the *documentation* says so, not the behavior itself (reproducing it
against a real bucket is optional, not required for this checklist):

- [ ] Confirm both the package README
      (`packages/plugin-storage-gcs/README.md`) and the site operations
      docs (`apps/crowi-site/content/docs/{ja,en}/operations/storage.mdx`)
      state that a GCS 404 caused by a deleted bucket, a revoked
      permission, or a wrong prefix is indistinguishable from a genuinely
      missing object from the driver's response alone, and that display
      (placeholder), strict download (`FILE_MISSING`), and derivative
      fallback behave accordingly — matching `local`/`s3`'s existing
      coarseness, not a GCS-specific regression.

## Active GCS connection changes are full-stop only

`gcsConnection` (bucket / prefix / project ID / service-account key) is a
single encrypted atomic-group document. Saving it while `gcs` is **not**
the active driver is a normal, hot-reloadable admin operation, exactly like
any other plugin config save — no special procedure needed.

Changing the connection while `gcs` **is** the active driver in a
multi-instance deployment is a different story: this feature does not add
any cross-replica coordination (no Redis pub/sub, no lease, no CAS). Each
API replica reconfigures its own in-process `StateCell` independently,
which means a naive online edit produces a window where some replicas are
still writing/reading against the old bucket/credentials and others have
already moved to the new ones. There is no supported online path for this.

Verify manually — without ever performing an online active-connection change
against a real multi-replica deployment; there is no supported recovery path
if replicas diverge, so every step here is a non-mutating design/code review,
not a live drift experiment:

- [ ] Confirm the only documented, supported procedure for changing an
      *active* GCS connection is: stop every API replica (and every
      storage-mutating CLI/background worker) → change the config → restart
      every replica. Capture this in the operator runbook alongside the
      existing S3 rotation procedure.
- [ ] Confirm, by reading `createGcsDriver`'s `reconfigure` handler and the
      `StateCell` it uses (`packages/plugin-storage-gcs/src/index.ts`), that
      each API replica reconfigures its own in-process state independently —
      no Redis pub/sub, no lease, no CAS, no cross-replica coordination
      exists anywhere in this feature. This is why an online active-connection
      change is unsupported (some replicas would keep writing/reading against
      the old bucket/credentials after others have already moved to the new
      ones) rather than merely undocumented — and why this checklist does not
      ask you to induce that condition, not even against a single replica.
- [ ] Confirm, by reading `createGcsDriver` (`packages/plugin-storage-gcs/src/index.ts`),
      that every method captures its bucket/client snapshot via
      `cell.withValue()` at call time, and that an in-flight `get()` keeps
      streaming from the snapshot it captured — a concurrent `reconfigure()`
      replaces the cell's *next* snapshot only, it does not reach into or
      cancel a `get()` already in progress on the old snapshot. Also confirm
      `reconfigure()` never disposes the old `Storage`/`Bucket` client: the
      Node `@google-cloud/storage` SDK has no documented close API (unlike
      `@aws-sdk/client-s3`'s `S3Client#destroy()`), so the old client stays
      usable for as long as an in-flight request holds a reference to it —
      there is nothing to tear down that could cut a request off early. This
      snapshot-isolation property is exercised end-to-end by an automated
      test in `packages/api/src/plugin/storage-gcs.test.ts` (an in-flight
      `put()` parked mid-pipeline against the old bucket survives a
      concurrent `reconfigure()` and completes against the old bucket,
      while a subsequent call after `reconfigure()` uses the new one); this
      step only asks you to re-read the code, not to reproduce it against a
      live bucket.

## Full-stop migration / cutover checklist

`crowi-admin rebuild storage copy` performs a **full-stop** copy from one
registered storage driver to another (e.g. `local` or `s3` → `gcs`). There
is no live/coordinated migration path — the spec deliberately does not
attempt one (per-route leases, watermarking, and delta cutover are all out
of scope). Follow this procedure exactly; skipping the stop step risks
silently losing writes made during the copy window.

1. **Stage the destination while the old driver is still active.**
   - [ ] Save a valid `gcs` connection (bucket/prefix/credentials) through
     the admin UI. `storage.driver` stays on the old driver (e.g. `s3`) —
     `gcs` is not yet selected.
   - [ ] Confirm the bucket is reachable and empty (or contains only
     objects you intend to overwrite) before starting.

2. **Stop every writer and every reader.** All of the following must be
   confirmed at zero for the duration of the copy — not just "no active
   users", but literally stopped processes:
   - [ ] Every API replica (`@crowi/api`) is stopped.
   - [ ] Every storage-mutating CLI invocation is stopped (`crowi-admin`
     commands other than the copy itself).
   - [ ] Every background/scheduled worker capable of touching storage is
     stopped (derivative rebuild jobs, page-history repair jobs, etc.).
   - [ ] Confirm zero in-flight operations across each of: attachment
     upload, attachment delete, profile image upload, page hard delete
     (which deletes attachments), and display-derivative
     generation/rebuild. Each of these calls into `FileUploader` and must
     be at zero — not just "quiesced" — before step 3.
   - [ ] Confirm read/delivery is also stopped for the duration (the copy
     window provides no service, by design — this is not a hot migration).

3. **Run the copy against the stopped system.**
   - [ ] Run `crowi-admin rebuild storage copy --from <old> --to gcs`
     (dry-run first if you want a preview; see the driver-neutral
     `runStorageCopy` behavior covered by
     `packages/api/src/util/storage-copy.test.ts`).
   - [ ] Confirm the run summary reports `failed: 0`. Any non-zero
     `failed` count blocks cutover — investigate and re-run (per-key
     copies are safe to retry: GCS `put` overwrites by key).
   - [ ] **Read-verify every copied object — not a sample.** `failed: 0`
     only proves the *upload* API call reported success for each object; it
     does not prove every object is still present and actually readable back
     from `gcs` afterwards (byte-level correctness of what was written is
     already covered separately — the GCS SDK's own upload integrity
     validation is never disabled, per the driver's `put()` design). The old
     driver's data is still intact and untouched at this point (nothing has
     been deleted from it), so the cheapest exhaustive presence/readability
     check that needs no new tooling is a **second copy run in the reverse
     direction, into a disposable scratch destination**:
     `crowi-admin rebuild storage copy --from gcs --to <scratch>`. `<scratch>`
     must be a registered driver distinct from `gcs` **and must not be the
     old driver still pointed at the original source data** — e.g. reusing
     `local`'s config as-is would overwrite the very rollback copy step 5
     depends on. A `local` driver instance repointed at a freshly-created,
     empty temp directory (safe to do — the system is fully stopped) works
     fine; discard that temp directory afterwards, it plays no other role.
     This forces every single object to be `get()` back off `gcs` — the
     actual "destination read verify" the migration needs.
     - [ ] The reverse run's summary reports the exact same `total` as the
       forward run, and `failed: 0`. A non-zero `failed` here means an
       object that reported a successful upload is not actually readable
       back from `gcs` — **this blocks cutover.** Do not proceed to step 4;
       investigate the specific failed key(s) (re-run the forward copy for
       just that key, then re-verify) before changing `storage.driver`.
     - [ ] Discard the scratch destination once the reverse run reports
       `failed: 0`; it played no other role.

4. **Flip the driver and restart.**
   - [ ] Change `storage.driver` to `gcs` in `crowi.config.json` (or the
     equivalent runner config) on every replica.
   - [ ] Restart every API replica.

5. **Post-cutover verification.**
   - [ ] Sampled attachment upload succeeds and is retrievable.
   - [ ] Sampled attachment delete succeeds (and is idempotent on retry).
   - [ ] Sampled profile image upload/change succeeds.
   - [ ] Sampled attachment proxy delivery (`GET /api/attachments/:id`)
     returns 200 with correct bytes.
   - [ ] Sampled strict download (`GET /api/attachments/:id/download`)
     behaves the same as it did on the old driver (no unexpected
     `FILE_MISSING`).
   - [ ] Re-enable background workers (derivative rebuild, etc.) and
     confirm a sampled display-derivative rebuild against a GCS-backed
     original succeeds.
   - [ ] Keep the old storage (bucket/volume) intact for a rollback
     window. Rollback, if needed, is the same full-stop procedure in
     reverse: stop every replica, flip `storage.driver` back, restart.

Do not treat this checklist as optional for a first production cutover —
none of its steps are enforced by code; the driver-neutral copy loop trusts
the operator to have actually stopped every writer/reader first.

## Documentation completeness read-through

Before closing this checklist out, confirm the following user-facing docs
are all present and mutually consistent — ja and en versions both, not
just one:

- [ ] `packages/plugin-storage-gcs/README.md`
- [ ] `apps/crowi-site/content/docs/ja/operations/storage.mdx` and
      `apps/crowi-site/content/docs/en/operations/storage.mdx`
- [ ] `apps/crowi-site/content/docs/ja/plugins/overview.mdx` and
      `apps/crowi-site/content/docs/en/plugins/overview.mdx` list `gcs` /
      `@crowi/plugin-storage-gcs` among the first-party plugins

Each of the operations docs (README + site, ja + en) must cover, in its
own words:

- [ ] ADC-first credential resolution, with the inline encrypted
      service-account key as an explicit fallback.
- [ ] That the four connection fields save as one encrypted atomic
      document, not independent rows.
- [ ] The object prefix and how it maps to the physical object name.
- [ ] Object CRUD permissions (`storage.objects.{create,get,delete}`) and
      V4 signed-URL signing (`signBlob`) as **separate** permission
      concerns, per the checklist above.
- [ ] That current attachment delivery routes remain Crowi-proxied — GCS
      `signedUrl()` capability does not change how attachments are served
      today.
- [ ] The full-stop migration/cutover procedure and rollback window.
- [ ] The bucket-deletion/permission-revocation misdisplay acceptance
      point (see above).
- [ ] That the opt-in emulator is not an IAM/ADC/`signBlob` oracle.
