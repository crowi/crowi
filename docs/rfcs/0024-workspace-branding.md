# RFC-0024: Workspace branding for multi-workspace identity

- **Status**: Draft
- **Created**: 2026-08-07
- **Related**:
  - RFC-0001 (Plugin Architecture) — storage drivers provide the object-store
    boundary used by the workspace logo.
  - RFC-0004 (Editor UX Enhancement) — provides the established image-upload
    and client-side crop precedent.
  - RFC-0012 (Crowi CLI) — establishes lenient `app/info` parsing and
    per-instance metadata caching outside the Web client.
  - RFC-0016 (Native Apple app for Crowi) — defines the multi-workspace model,
    pre-authentication `app/info` probe, and per-workspace cache extended here.

## §0 Summary

Crowi will expose a first-class, public workspace identity so that people can
recognize which Crowi instance they are about to enter, are currently using,
or are switching to. An administrator can upload a square workspace logo and
choose one of five audited color presets. Web and iOS consume the same public
identity before authentication and throughout the workspace shell.

The public `GET /api/app/info` response gains a `branding` object:

```json
{
  "branding": {
    "theme": "teal",
    "logoUrl": "/api/app/logo.webp?revision=01J...opaque..."
  }
}
```

The public wire type of `theme` is a string for forward compatibility. The
known initial values are `teal`, `blue`, `indigo`, `violet`, and `rose`.
Administrative writes accept only those five values. Missing or unknown values
render as `teal`; a missing `branding` object from an older server renders the
existing Crowi identity.

The logo is not a page attachment. The API normalizes an administrator upload
to one 1024×1024 WebP object, writes an immutable content-addressed candidate,
and atomically advances the durable state pointer only after that write. A
stable API-relative endpoint serves the current object with `ETag` and
`Cache-Control: no-cache`; a revision query changes when an administrative
write succeeds so already-rendered clients receive a new image URL without
making the query a storage selector. The endpoint neither creates an
`Attachment` nor inherits page-grant authorization.

Each preset is an explicit light/dark semantic token set. Presets control
workspace chrome and existing brand accents. They do not recolor destructive,
success, warning, page-grant, chart, permission, or user-identity semantics. Five
sets are small enough to audit directly; Crowi will not derive them from a hue
or seed.

Workspace title, theme, logo URL, and normalized logo bytes are intentionally
public even when `confidential` is configured. This is necessary because the
feature's primary purpose is to identify a workspace before login. Crowi
already exposes `title` and the `confidential` notice through the same public
endpoint (`packages/api-contract/src/schemas/app.ts:5-17`,
`packages/api/src/hono/handlers/app.ts:64-76`). Operators that must conceal the
existence or identity of an instance must restrict network reachability.

## §1 Motivation

One person may use several independent Crowi instances. RFC-0016 makes that a
first-class iOS use case, but the same ambiguity exists in login screens and
administrative shells: every instance primarily presents the Crowi product
identity. A user can begin an OAuth or password flow without strong visual
confirmation of the organization whose workspace they are entering. The Web
also updates its document title after public discovery so an already-open tab
becomes identifiable; it does not promise branded tab text before that first
client-side response.

The server already exposes public instance discovery. The app contract calls
`GET /app/info` “public application info”
(`packages/api-contract/src/contracts/app.ts:17-29`), and Hono registers it in
the public route group before authenticated route families
(`packages/api/src/hono/index.ts:154-166`). Its response includes the effective
title and confidentiality notice. RFC-0016 already requires iOS to call this
endpoint before OAuth, cache the result per workspace, and refresh it on
activation, foreground entry, and a ten-minute TTL
(`docs/rfcs/0016-ios-native-app.md:264-285`,
`docs/rfcs/0016-ios-native-app.md:654-667`).

Workspace branding belongs on that discovery boundary. An authenticated-only
logo would appear only after the user had already chosen a workspace and
entered credentials, which would miss the main safety and usability benefit.

## §2 Goals, non-goals, and terminology

### §2.1 Goals

- Make a workspace recognizable before authentication, while switching, and
  during ordinary use.
- Give administrators one square logo slot and five predictable color presets.
- Keep one stable preset vocabulary across API, Web, and iOS while allowing
  future servers to add presets without breaking older clients.
- Keep workspace identity independent from pages, attachments, users, and page
  grants.
- Work with every active storage driver through the existing storage
  abstraction.
- Propagate logo replacement without expiring signed URLs, cache purges, or
  retained historical logo objects.
- Preserve recognizable light/dark behavior and WCAG AA contrast for every
  supported preset.
- Preserve the meaning of functional, safety, data, and user-identity colors.
- Preserve workspace logos when an operator copies objects between storage
  drivers.

### §2.2 Non-goals

- Arbitrary HEX/RGB colors, custom CSS, or operator-provided token sets.
- Per-user or per-page branding.
- Multiple logo variants, horizontal logo uploads, favicons, login
  backgrounds, slogans, or removal of all Crowi product identity in the first
  release.
- SVG, GIF, animated WebP/APNG, AVIF, or other upload formats beyond PNG, JPEG,
  and non-animated WebP.
- Concealing an Internet-reachable Crowi instance.
- Storing branding in an `Attachment`, a hidden `Page`, or `User.picture`.
- Revoking bytes that a browser, native client, proxy, or CDN has already
  received from the public logo endpoint.
- Making the CLI render or persist branding in the first release.

### §2.3 Terminology

- **Product identity** means Crowi's bundled logo and default teal appearance.
- **Workspace identity** means the operator-configured title, logo, and preset
  associated with one Crowi instance.
- **Brand-controlled tokens** are visual emphasis and workspace-chrome tokens
  whose color may change with a preset.
- **Functional tokens** communicate behavior, safety, state, access, data
  series, or a person's identity and do not change with workspace branding.

## §3 Decision: public workspace identity

### §3.1 Public disclosure is required behavior

The following values are public instance metadata:

- effective workspace title;
- confidentiality notice;
- selected preset identifier;
- current logo URL; and
- normalized logo bytes.

They are available without a cookie, Bearer token, or completed installation
session once the instance is installed. The Admin UI must state that the logo
and title are visible before login.

This disclosure is accepted for confidential instances. In Crowi,
`app:confidential` is an operator-provided notice displayed to viewers; it is
not a network access control and does not promise that the instance's identity
is hidden. The current unauthenticated response already returns that notice and
the configured title (`packages/api/src/hono/handlers/app.ts:64-76`). Publishing
a visual identity adds no user, page, membership, grant, bucket, storage-key,
or credential data.

An operator that needs instance-name secrecy must enforce it before Crowi,
using a private network, VPN, reverse-proxy authentication, or equivalent
access control. An opt-in public-branding switch is not added because disabling
branding before authentication would make the feature fail its main purpose
and would create another discovery state every client must explain.

### §3.2 Public `app/info` contract

New servers return a required `branding` object:

```ts
type PublicWorkspaceBranding = {
  theme: string;
  logoUrl: string | null;
};
```

The initial known presets are:

```ts
type BrandingThemePreset =
  | 'teal'
  | 'blue'
  | 'indigo'
  | 'violet'
  | 'rose';
```

The public response deliberately uses `z.string()` for `branding.theme`, not a
strict five-value enum. Administrative writes use the strict enum. This split
prevents a sixth preset introduced by a future server from invalidating the
entire public response in a client that recognizes only five values.

This constraint matters to the existing CLI. Its current one-shot
`AppInfoResponseSchema.partial().safeParse()` discards every field if a present
nested member is malformed (`packages/cli/src/lib/capability.ts:47-70`);
making nested members `nullish()` would not change that, because `nullish()`
does not accept an incorrectly typed present value. The CLI must instead parse
a branding-independent projection of the unknown response, containing only
`version`, `apiVersion`, and `capabilities`, with a separate
`safeParse`/`pick` boundary. It must never parse `branding` while detecting
capabilities. Branding-aware renderers may independently safe-parse branding
and fall back when that parse fails. The server contract still validates and
emits the precise type above.

Compatibility rules are:

| Server/client condition | Required behavior |
| --- | --- |
| New server, current client | Render the configured preset and logo. |
| Old server without `branding` | Render Crowi's product identity and `teal`. |
| New server with unknown `theme` | Render `teal`; keep all other app-info fields. |
| `logoUrl: null` | Render the existing Crowi icon or lockup. |
| Logo fetch fails | Render the existing Crowi icon or lockup; do not block login or switching. |
| Old client | Ignore the additive `branding` object. |

`logoUrl` must be API-relative and same-origin, for example
`/api/app/logo.webp?revision=<opaque-version>`. The path is stable. The query is
a cache-busting hint generated by the server; it never selects a historical
object and is not incorporated into a storage key. It must never contain a
storage bucket URL, signed URL, arbitrary administrator URL, or user-supplied
storage key. The `app/info` handler derives the URL from the dedicated branding
state document and performs no storage I/O. It remains usable when the current
logo object is missing or the storage driver is unavailable.

The server should send `Cache-Control: no-cache` on `app/info`. Clients may
retain and revalidate their own snapshots according to the policies in §8, but
an intermediary must not silently extend the discovery response's freshness.

### §3.3 Dedicated branding state

Theme and logo state share one singleton `WorkspaceBrandingState` document;
branding does not add an `app:brandingTheme` Config key. This prevents the
public theme from depending on `crowi.getConfig()`, which is a process-local
cache (`packages/api/src/service/config.ts:34-38`) asynchronously refreshed by
Redis pub/sub (`packages/api/src/service/config.ts:267-278`). The document has
the following logical shape:

```ts
type WorkspaceBrandingState = {
  _id: 'workspace-branding';
  theme: BrandingThemePreset;
  currentVersion: string | null;
  revision: number;
  pendingLogoDelete: string | null;
};
```

`theme` is seeded as `teal`; a missing or invalid legacy document is normalized
to `teal` on read and repaired by the migration. `currentVersion` is the
unpadded base64url SHA-256 digest of the normalized bytes: 43 characters
matching `^[A-Za-z0-9_-]{43}$`. It supplies the `revision` query in `logoUrl`,
the strong response validator, and the deterministic immutable storage key in
§4.2. `revision` is a monotonically increasing internal compare-and-set
revision for administrative writes. `pendingLogoDelete` names a superseded
digest whose object has not been confirmed deleted yet (§4.2). The constant
`_id` gives the singleton an intrinsic unique key.

This separate document is required by the current Config storage shape. Config
contains only `ns`, `key`, and `value`, has separate non-unique indexes, and
writes with `findOneAndUpdate(..., { upsert: true })`
(`packages/api/src/models/config.ts:16-21`,
`packages/api/src/models/config.ts:107-111`,
`packages/api/src/models/config.ts:154-163`). Giving Config reliable CAS
semantics would first require repository-wide duplicate cleanup and a compound
unique index, putting unrelated settings at migration risk. Workspace branding
does not impose that migration.

The existing App administration route remains behind admin middleware
(`packages/api/src/hono/handlers/admin/app.ts:36-80`), but its branding theme
field reads and updates `WorkspaceBrandingState` with a revision CAS rather
than Config. Theme-only updates increment `revision`, leave `currentVersion`
unchanged, and publish branding-state invalidation. Logo and theme updates use
failure-propagating state operations; neither path may call the
error-swallowing Config helpers at `packages/api/src/models/config.ts:178-203`.

Neither Config nor `WorkspaceBrandingState` stores image bytes, a data URL, a
signed URL, a declared MIME type, a filename, or an external origin. The
storage key is derived only from the validated `currentVersion`, and the public
URL is derived only after that version has been validated.

## §4 Logo asset model

### §4.1 One normalized square asset

The canonical logo is a square 1024×1024 WebP. A square icon fits the iOS
workspace switcher and compact Web header, while the effective workspace title
beside it supplies the horizontal wordmark use case. The first release does not
store a separate horizontal lockup.

The Admin Web UI reuses or generalizes the existing client-side square crop
flow. That flow already accepts a crop rectangle, draws it to a square canvas,
and emits WebP with PNG fallback (`packages/web/src/lib/crop-image.ts:1-12`,
`packages/web/src/lib/crop-image.ts:35-79`). The branding variant uses 1024
pixels rather than the avatar helper's 256 pixels.

Client-side cropping is a usability and upload-size optimization, not a trust
boundary. The server always decodes and normalizes the uploaded bytes. A
non-Web client may upload a non-square raster; the server uses `fit: contain`
with transparent padding rather than silently cropping meaningful content.

### §4.2 Immutable content-addressed storage objects

The current object key is deterministically derived from the committed digest:

```text
branding/logo/<currentVersion>.webp
```

`currentVersion` has the fixed digest grammar in §3.3. No request value, query,
Config value, or uploaded filename is concatenated into this key. The
`revision` query changes client cache identity only; the state document selects
the object. A candidate object is never served until its digest is committed by
the state CAS, so a crash after its upload can create only an unreachable
orphan, never change the public logo.

This is a named instance asset in the active storage driver. The reusable
boundary is `FileUploader`/`StorageDriver`, which already provides put, get,
and idempotent delete operations (`packages/api/src/util/file-uploader.ts:35-50`,
`packages/api/src/util/file-uploader.ts:75-116`). The user-picture
`persistentUrl` helper is not reusable: its contract is explicitly limited to
`user/` keys and the authenticated attachment proxy
(`packages/api/src/util/file-uploader.ts:63-72`).

The implementation must not create an `Attachment` or synthetic `Page`.
Attachment grants describe wiki content, while this object is public instance
identity. The current by-key attachment stream deliberately accepts only the
`user/` prefix (`packages/api/src/hono/handlers/attachment-stream.ts:469-505`);
expanding it to `branding/` would mix distinct authorization and delivery
boundaries.

The driver put creates a previously absent digest key. If a retry finds that
key, it must verify the bytes hash to the expected digest before treating the
put as idempotently complete; a mismatch is an operational error. Local writes
and S3 puts remain individually atomic
(`packages/plugin-storage-local/src/index.ts:91-117`,
`packages/plugin-storage-aws-s3/src/index.ts:83-97`), but correctness no
longer depends on either forming a transaction with Mongo.

Superseded objects are removed without enumerating storage. The state CAS that
commits a new `currentVersion` writes the digest it superseded into
`pendingLogoDelete` in the same update, so the obligation to delete is durable
before any deletion is attempted. The winner then issues the delete and, on
success, clears `pendingLogoDelete` with a second CAS guarded by that digest
value.

Every administrative write first discharges a non-null `pendingLogoDelete`:
replace and clear retry that delete and clear the field before proceeding.
`StorageDriver.delete` is idempotent by contract
(`packages/plugin-api/src/registries/storage.ts:38`), so retrying a delete that
already succeeded is a no-op. A writer never deletes the digest it just
committed, because the field always names the previous one.

This is the outbox shape RFC-0021 already uses for a single durable follow-up
obligation (`packages/api/src/models/page.ts:531-538`): one nullable field, one
committing write, and retry on the next write of the same kind.

There is deliberately no reconciler and no storage-prefix enumeration. A list
operation would be a permanent addition to the published `StorageDriver`
contract, which today is exactly put, get, delete, and optional `signedUrl`
(`packages/plugin-api/src/registries/storage.ts:27-46`). Pagination, prefix
semantics, and read-after-write consistency differ per backend, so every driver
— including third-party ones — would have to implement and keep implementing it
correctly. Carrying that surface forever to reclaim a handful of small images is
a worse trade than one nullable state field.

The residual case is narrow: if a replacement's delete fails and the next
replacement's retry also fails, the older digest is overwritten in the slot and
its object is left unreferenced. It is never served, because only the committed
digest is reachable. Operators can remove keys under `branding/logo/` that match
neither `currentVersion` nor `pendingLogoDelete`, which the operations
documentation states.

### §4.3 Public delivery endpoint

`GET /api/app/logo.webp` is public and registered with other app routes. It:

1. read-through loads the singleton branding state;
2. returns `404` when `currentVersion` is null;
3. derives and loads only `branding/logo/<currentVersion>.webp`;
4. streams only that normalized object; and
5. never redirects to a driver-signed URL.

The optional `revision` query is ignored for authorization and storage lookup.
Consequently, a five-minute-stale app-info URL resolves to the current logo
after replacement. A missing committed object is an operational consistency
failure, not a substitution: it returns `404` with `Cache-Control: no-store`
and is repaired by the explicit recovery procedure in §5.2. A storage-driver
failure returns the project's corresponding observable server error, also with
`Cache-Control: no-store`. An app-info request remains successful in either
case.

A successful response sets:

```http
Content-Type: image/webp
Cache-Control: public, no-cache
ETag: "<current-version>"
X-Content-Type-Options: nosniff
```

The global API middleware already adds `nosniff` to every response
(`packages/api/src/hono/middleware/security-headers.ts:22-27`). The route still
owns the fixed media type and revalidation contract. It does not reflect an
uploaded filename or MIME claim in any header.

The route honors `If-None-Match` with `304` only after loading bytes and
verifying their SHA-256 digest equals `currentVersion`. `no-cache` permits
storage while requiring revalidation before reuse; it does not mean `no-store`.
A digest mismatch is a non-cacheable operational error and must never return
bytes or `304`. This makes the state pointer and representation atomic from the
public reader's perspective.

The route must use a bounded per-process byte cache keyed by the committed
current version, invalidated after successful writes and cross-replica state
invalidation. It must not key that cache by the request query. The route must
also apply a public, pre-authentication IP rate limiter before any storage
`get()`, returning `429` and `Retry-After`. The limiter is a new anonymous
middleware: the existing user-based limiter cannot be reused because it
requires `c.get('user')` after JWT authentication.

Client identity comes from the direct peer address in `c.env.incoming` by
default. A deployment may opt into forwarded identity only by configuring the
validated `TRUSTED_PROXY_CIDRS` CIDR allow-list. When, and only when, the peer
is in that allow-list, the middleware parses `Forwarded` first (or a documented
`X-Forwarded-For` fallback), rejects malformed values, and selects the first
address from the right that is not a trusted proxy. If the peer is untrusted,
all forwarded headers are ignored. An empty allow-list is the safe default; it
may group all users behind an unconfigured reverse proxy, but never lets a
client choose its limiter key. The implementation spec must define IPv4/IPv6
normalization. In multi-instance deployments the budget is Redis-backed; without Redis the instance may use only the
documented single-instance in-process fallback. Query strings do not alter the
object identity, validator, or limiter key.

`app/info` and the logo route must not rely on the process-local settings cache
for branding correctness. They read the complete `WorkspaceBrandingState`
(including `theme`) through a
MongoDB-backed read-through cache with a maximum 30-second TTL and invalidate it
on branding-state pub/sub. Redis improves propagation latency but is not the
source of truth. A multi-instance deployment must configure Redis and pass a
branding readiness check for its state subscriber and public limiter; if that
check is unavailable, branding writes are rejected and public reads use the
durable read-through path rather than an indefinitely stale local value.

## §5 Administrative writes and consistency

### §5.1 API surface

The admin-only surface is:

- `GET /api/admin/app` — returns `brandingTheme`, current `logoUrl`, and the
  existing `isUploadable` state.
- `PUT /api/admin/app` — accepts a strict optional `app.brandingTheme` field in
  addition to existing App settings.
- `POST /api/admin/app/logo` — accepts one multipart `file` and replaces the
  current logo.
- `DELETE /api/admin/app/logo` — clears the custom logo.

The existing route family already installs `createJwtAdminRequired` on both
`/admin/app` and `/admin/app/*`
(`packages/api/src/hono/handlers/admin/app.ts:36-46`). Logo upload and clear
remain under that boundary. Unauthenticated and non-admin requests receive the
existing authentication/admin error shapes.

Theme selection does not require a storage driver. The Admin UI disables logo
upload when `isUploadable` is false but still permits theme changes and logo
clear where the branding state can be updated.

### §5.2 Replacement protocol

Replacement publishes an immutable candidate through the dedicated state
document:

1. Stream the bounded multipart body to a private temporary file as §6.3
   requires; decode, validate, orient, strip metadata, and normalize it to
   WebP. Compute a deterministic opaque version from the normalized bytes.
2. Read `WorkspaceBrandingState`.
3. Put the candidate once to `branding/logo/<new-version>.webp`, verifying the
   digest when retrying an existing candidate key.
4. CAS the singleton document from the observed `revision` to
   `{ currentVersion: <new-version>, revision: <revision + 1>,
   pendingLogoDelete: <previous currentVersion, or null> }`. On success,
   invalidate local state/byte caches, publish cross-replica invalidation, and
   discharge `pendingLogoDelete` as §4.2 describes.
5. If the CAS fails, return a conflict, publish no invalidation, and delete
   nothing. The unreachable candidate is left in place; it is never served, and
   the next successful replacement does not reference it.

The document revision is the durable stale-writer guard. There is deliberately
no mutation lease, rollback, or delete of a previously committed object in the
write path: a paused or crashed writer can at most leave an unreferenced,
content-addressed candidate. It cannot overwrite a later committed logo. A put
failure leaves state unchanged. A crash after candidate put but before state
CAS leaves the old state and old immutable object publicly serving; a crash
after CAS leaves the new pointer and already-written immutable object publicly
serving, with the superseded digest recorded in `pendingLogoDelete` so the next
administrative write finishes the deletion. If a committed object is missing or corrupt, the public handler fails
closed as §4.3 requires. Recovery must either restore the bytes for that exact
digest from a verified backup or clear/re-upload through a state CAS; it must
never serve different bytes under the committed digest.

Concurrent replace/replace and replace/clear tests must prove state-CAS
behavior, candidate-orphan safety, cache invalidation, and that a losing writer
cannot mutate or delete the winning object's key before this phase can ship.

### §5.3 Clear protocol

Clear reads the singleton and CASes `currentVersion` to `null` from the observed
`revision`, writing the cleared digest into `pendingLogoDelete` in the same
update. On success it invalidates local caches, publishes state invalidation,
and discharges the pending delete as §4.2 describes. If the CAS fails, it
publishes no invalidation and deletes nothing. Because the slot names the exact
digest the winner observed, a clear that races a replacement cannot delete a
later committed object.

### §5.4 Storage-driver copy

Storage copy currently enumerates `Attachment.filePath` and then user images
because user pictures live outside the Attachment collection
(`packages/api/src/util/storage-copy.ts:53-94`). Workspace branding introduces
another non-Attachment object. The copy command must additionally derive and
copy `branding/logo/<currentVersion>.webp` when `currentVersion` is not null,
including dry-run, progress, error, and summary accounting. It must not
enumerate the storage prefix.

`runStorageCopy` stages data while the old driver remains active, and an
operator later changes `crowi.config.json` and restarts
(`packages/api/src/util/storage-copy.ts:36-43`). Crowi does not offer
zero-downtime storage-driver switching: the operator performs the switch in a
maintenance window with writes stopped. Branding relies on that same operational
boundary rather than introducing a durable fence of its own.

The procedure is therefore:

1. The operator stops administrative writes (the maintenance window).
2. `crowi-admin storage copy` copies the committed immutable key alongside the
   attachment and user-picture objects it already handles, then reads the target
   bytes back and verifies their digest. A missing source object is reported and
   aborts the run.
3. The operator changes the active driver configuration and restarts every
   replica. A startup check reads and verifies the committed key before the
   service is declared ready.

Because the logo object is immutable and content-addressed, a copy cannot go
stale in the way a mutable key could: a replacement during the window would
create a new digest and a new pointer, and step 3's startup verification fails
closed if the committed digest is absent on the target. A durable cross-process
fence would only add a state field, a token protocol, and a new failure mode
that the operator's own maintenance window already covers.

## §6 Upload and image security policy

### §6.1 Admission and normalization

The logo endpoint has a narrower policy than general attachments:

- one multipart field named `file`;
- at most 5 MiB of declared and actually received input;
- decoded PNG, JPEG, or non-animated WebP only;
- no SVG, GIF, APNG, animated WebP, AVIF, or other decoder format;
- an explicit decoded-pixel ceiling applied before expensive transforms;
- EXIF orientation applied;
- metadata, including EXIF and unneeded color-profile metadata, stripped;
- output always re-encoded to a single-frame 1024×1024 WebP; and
- no trust in filename extension or multipart `Content-Type`.

`sharp` is already used with `limitInputPixels`, real decoder metadata,
animation rejection, orientation, and re-encoding for display derivatives
(`packages/api/src/util/image-display-derivative.ts:323-364`). Branding should
reuse those low-level safety patterns where their contracts match, while
keeping its fixed square output and public-delivery rules separate.

The existing profile-picture endpoint only checks a declared `image/*` MIME
before upload (`packages/api/src/hono/handlers/me.ts:350-392`). That check is
not sufficient for a public same-origin asset and must not be copied as the
logo's security boundary.

### §6.2 Relationship to attachment MIME policy

General attachment upload currently applies filename-based MIME fallback when
a client omits a type, based on the work landed in commit `8f6b864b`; the
active policy and rationale are in
`packages/api/src/hono/handlers/attachment.ts:126-163`. A separate
`feature-upload-policy-endpoint` design is responsible for publishing that
general attachment policy to clients.

The logo implementation must coordinate with that policy for shared multipart
limits, error vocabulary, and client guidance, but it must not inherit the
general attachment allow-list. A declared or inferred MIME is only a hint for
logo UX. Successful raster decoding and the dedicated three-format allow-list
are authoritative. Branding also must not inherit Attachment authorization,
because a logo is not associated with a Page.

### §6.3 Resource exhaustion and failure behavior

This route must not use `c.req.parseBody()`: in the current Hono Node adapter
that API buffers the entire multipart request before a `File` or a helper can
write a temporary file. The endpoint instead consumes `c.env.incoming` with a
streaming multipart parser (Busboy or an equivalent Node-stream parser). A
byte-counting transform runs before multipart parsing and aborts/destroys the
request at 5 MiB **aggregate request bytes**, including boundaries and fields;
the parser separately applies a 5 MiB file limit, permits exactly one `file`
part and no unexpected file parts, and streams the accepted file directly to a
private temporary file. `Content-Length` is only an optional early rejection,
not the enforcement mechanism.

On a byte-limit event, malformed multipart stream, client abort, parser error,
or downstream decoder failure, the handler must stop reading, destroy the
pipeline, close/unlink the temporary file, and return the stable 413/validation
error when a response is still possible. It must apply the decoded-pixel ceiling
to metadata inspection and the final transform. Malformed, truncated,
polyglot, animated, or unsupported input returns a stable validation error and
does not modify the branding state or current object.

Temporary files are removed on success and on every failure path. Decoder,
driver, and branding-state errors are logged without including image bytes or
secrets.

## §7 Theme model and semantic boundary

### §7.1 Five explicit light/dark token sets

The five preset identifiers are `teal`, `blue`, `indigo`, `violet`, and
`rose`. `teal` matches the current Crowi appearance and is both the seeded
default and fallback.

Each preset defines explicit reviewed values for light and dark mode. Web uses
selectors that compose a workspace attribute with the existing `.dark` class:

```css
html[data-workspace-theme="blue"] {
  /* audited light values */
}

html.dark[data-workspace-theme="blue"] {
  /* audited dark values */
}
```

Crowi will not derive these values from a seed, hue, or algorithm. A derivation
rule would become a permanent cross-client contract, would require Web and iOS
to reproduce clipping and contrast correction identically, and is unnecessary
for five choices. Explicit sets can be reviewed surface by surface.

### §7.2 Preset-controlled tokens

Presets control the following semantic families and their foreground pairs:

| Family | Web tokens | Intended surfaces |
| --- | --- | --- |
| Primary brand | `--primary`, `--primary-foreground` | Primary actions, links, branded emphasis |
| Workspace header | `--crowi-header`, `--crowi-header-foreground` | Public/login identity chrome and persistent workspace chrome |
| Secondary brand | `--secondary`, `--secondary-foreground` | Branded secondary surfaces |
| Accent brand | `--accent`, `--accent-foreground` | Hover, selection, and branded accent surfaces |
| Focus brand | `--ring` | Ordinary focus indication, with contrast preserved |
| Sidebar brand | `--sidebar-primary`, `--sidebar-primary-foreground`, `--sidebar-accent`, `--sidebar-accent-foreground`, `--sidebar-ring` | Workspace navigation emphasis |

The root stylesheet currently defines these as explicit light and dark values
(`packages/web/src/app/globals.css:69-121`,
`packages/web/src/app/globals.css:156-210`). The implementation adds preset
overrides; it does not introduce arbitrary custom-property input.

Workspace-chrome gradients and other hard-coded teal values must be audited,
not only token declarations. For example, authenticated and admin loading
screens combine `--crowi-header` with literal teal OKLCH stops
(`packages/web/src/app/(auth)/layout.tsx:107`,
`packages/web/src/app/(admin)/layout.tsx:65`). Those literal stops must become
audited preset-controlled chrome tokens or be replaced by a token-only
composition. The audit also includes `.bg-crowi-login`'s light/dark literal
teal/blue gradient stops and `.crowi-top-border`'s literals
(`packages/web/src/app/globals.css:288-306`, `:322-324`); all become audited
workspace-chrome tokens. The public login lockup
(`packages/web/src/app/(public)/login/page.tsx:33`) must use the shared brand
presentation rather than a bundled logo directly.

The following existing brand-state consumers intentionally follow the selected
workspace preset:

| Consumer | Meaning |
| --- | --- |
| `packages/web/src/components/page-view/bookmark-button.tsx:27` | Bookmarked toggle |
| `packages/web/src/components/page-view/watch-button.tsx:36` | Watching toggle |
| `packages/web/src/components/page-view/like-button.tsx:36` | Liked toggle |
| `packages/web/src/components/notification-list/notification-item.tsx:40` | Unread indicator |
| `packages/web/src/components/notification-list/notification-list.tsx:68` | Notification-list heading bell |

The bookmark, watch, and like controls are adjacent instances of the same
toggle pattern; keeping only one outside the preset would be visually
inconsistent. All five currently consume `text-primary` or `bg-primary`, so
they remain on the brand-controlled side of the boundary.

### §7.3 Fixed functional and identity tokens

The following remain independent of the workspace preset:

| Fixed family | Current examples | Reason |
| --- | --- | --- |
| Destructive/danger | `--destructive`, `--crowi-danger` | Destructive action and error meaning |
| Success | `--crowi-success` | Successful/live state meaning |
| Warning | `--crowi-warning` | Warning meaning |
| Page grant | `--page-grant-accent` selectors | Access/privacy meaning |
| Background surfaces | `--background`, `--card`, `--popover`, muted, border, input, base sidebar surface | Readability and neutral surface hierarchy |
| Charts | `--chart-1` through `--chart-5` | Stable data-series distinction |
| Permission identity | Administrator and other role badges | Authority must not look workspace-dependent |
| User identity | Standard avatar palettes | A person must not appear to change identity between workspaces |

The fixed functional tokens are already separate in the stylesheet
(`packages/web/src/app/globals.css:105-141`,
`packages/web/src/app/globals.css:194-223`). Preset selectors must not override
them. Component tests must verify that destructive, success, warning,
page-grant, permission, and user-identity indicators retain their intended
tokens under all presets.

`--crowi-bookmark` is declared in the light and dark token sets
(`packages/web/src/app/globals.css:124`,
`packages/web/src/app/globals.css:213`) but has no component consumer. The
actual bookmarked control uses `text-primary`
(`packages/web/src/components/page-view/bookmark-button.tsx:27`), so classifying
bookmark as fixed would contradict the implemented brand-controlled toggle.

There is no `--crowi-primary` token in the current Web theme. Tailwind's
`primary` color maps to `--primary`
(`packages/web/src/app/globals.css:33-44`,
`packages/web/src/app/globals.css:76-79`). The standard `UserAvatar` fallback
also does not use a workspace token; it uses the `boring-avatars` `beam` variant
with a fixed five-color palette
(`packages/web/src/components/user-avatar.tsx:34-45`) and remains fixed.

`PageDisplayUserBadge` is the outlier: it builds its own `Avatar` and uses
`bg-primary/10 text-primary` for an initials fallback
(`packages/web/src/components/page-display-user-badge.tsx:15-22`). Replace that
hand-built avatar with `UserAvatar`; do not add a user-identity token. The page
list already passes the same `resolveDisplayUser` result directly to
`UserAvatar` (`packages/web/src/components/page-list/page-list-item.tsx:106-108`),
so the portal header, page meta-chip row, and page list can share the standard
fixed avatar behavior without a new type adaptation.

The administrator badge is the opposite case. It currently uses
`bg-primary/10 text-primary`
(`packages/web/src/components/admin/users-table.tsx:231-235`), but it expresses
authority rather than an active toggle. Before preset overrides land, it must
move to a fixed permission-role style and must not follow the workspace theme.
Other `primary`, `secondary`, and `accent` consumers are brand-controlled by
default unless the audit identifies a functional, permission, or identity
meaning that requires the same separation.

### §7.4 Accessibility and cross-platform meaning

Every preset × light/dark combination is release-gated on:

- WCAG AA contrast for text and meaningful icons;
- visible keyboard focus;
- distinguishable selected, hover, and disabled states;
- readable public/login and workspace chrome;
- unchanged destructive, success, warning, and page-grant meaning; and
- recognizable equivalence between Web and iOS.

iOS does not have to reproduce Web's OKLCH numbers. Its checked-in semantic
colors must match the canonical swatches and role intent closely enough that a
workspace selected as `violet`, for example, is recognizably the same identity
on both platforms. Values are explicit on both platforms; neither platform
derives colors at runtime.

## §8 Web behavior and propagation

### §8.1 Global synchronization

All Web routes share `Providers`
(`packages/web/src/lib/providers.tsx:78-95`). A single
`WorkspaceBrandingSync` client component under that provider reads the shared
app-info query, normalizes the theme identifier, and sets
`document.documentElement.dataset.workspaceTheme`.

Missing data, query error, or an unknown theme resets the attribute to `teal`;
an untrusted response string is never interpolated into CSS. The existing
`useAppInfo` query has a five-minute stale time and no focus refetch
(`packages/web/src/lib/use-app-info.ts:10-22`). The first release accepts a
bounded default-teal/product-identity flash before the public query resolves
rather than adding a second localStorage or inline-script source of truth.
It must not describe that initial paint as branded. Once app-info resolves, the
same component updates `document.title` to `<workspace title> | Crowi` (or the
existing `Crowi` fallback); public login's hard-coded `サインイン | Crowi` title
follows this rule after discovery. Favicons remain a non-goal.

### §8.2 Identity surfaces

Branding applies to login, registration, recovery, invite, installer fallback,
authenticated, and admin surfaces after public app-info resolves. Public pages
currently render bundled Crowi logo files directly, including the login page
(`packages/web/src/app/(public)/login/page.tsx:29-35`); those surfaces must use
a shared workspace-aware brand presentation where app-info is available. The
default first paint remains the documented product-identity fallback.

`SiteBrand` already consumes `app/info` and is shared by authenticated and admin
headers (`packages/web/src/components/site-brand.tsx:7-29`). Its precedence
becomes:

1. custom workspace logo plus `title ?? "Crowi"`;
2. no custom logo but a custom title: bundled Crowi icon plus title; and
3. neither: existing full Crowi lockup.

An image load error immediately falls back to the appropriate bundled Crowi
icon or lockup. The title remains visible so a broken logo never erases the
workspace identity. The Web resolves the API-relative URL through
`resolveApiUrl`, which already supports same-origin and split Web/API origins
(`packages/web/src/lib/api-client.ts:24-45`).

### §8.3 Update propagation

The saving admin tab refreshes immediately. The existing App settings mutation
already invalidates both admin settings and app-info
(`packages/web/src/lib/use-admin-app-settings.ts:51-77`); theme, upload, replace,
and clear mutations preserve that behavior.

Other tabs may retain branding until the current five-minute app-info stale
window ends. No polling or `BroadcastChannel` is required in the first release.
The path is stable, while a successful replacement changes its `revision`
query. A newly refreshed app-info therefore gives an already-rendered image a
new cache identity. A tab with five-minute-stale app-info may still request the
old query, but §4.3 requires revalidation and ignores the query for object
selection, so that request resolves to the current committed object. No cache
purge or historical-logo retention window is required.

## §9 iOS behavior

This RFC extends RFC-0016's existing workspace model; it does not introduce a
second discovery flow.

The tolerant per-workspace app-info view adds:

```swift
struct WorkspaceBranding {
    let theme: String
    let logoURL: URL?
}
```

The add-workspace confirmation, workspace switcher, and active workspace shell
show the cached logo, title, and preset. Missing branding on an older host,
unknown themes, a `404`, offline cache miss, or decode failure falls back to the
Crowi product identity without blocking workspace addition or switching.

The logo URL is rebased only against `workspaceOrigin`. iOS accepts a
workspace-relative URL or an absolute same-origin HTTPS URL. It rejects another
origin, userinfo, non-HTTPS production URL, or redirect to another origin. The
logo request intentionally sends no Bearer token because the endpoint is
public. The server endpoint must not redirect to a storage provider.

iOS reuses RFC-0016's app-info refresh policy: add-workspace probe, workspace
activation, app foreground, and otherwise a ten-minute TTL. Workspace switching
uses cached branding immediately and refreshes afterward. Branding identifiers
and public logo bytes are non-secret, but caches must remain keyed by normalized
workspace origin so one host's identity cannot appear under another.

## §10 Security and privacy considerations

### §10.1 Public metadata and cache revalidation

Branding is public by design. Admin copy must make the pre-login disclosure
clear. Logo clearing removes the URL from future app-info responses and makes
the handler return `404`; failure to delete the reserved storage slot does not
make it serveable while `currentVersion` is null. Clearing is not secure erasure
from browser, device, proxy, backup, or CDN caches that already received the
bytes.

The public response exposes no user or page data and no operator-controlled
external URL. A relative URL prevents a malicious or corrupted branding-state
value from directing clients to another host. iOS independently enforces the
origin rule as defense in depth.

### §10.2 Upload boundary

Only administrators can upload, replace, or clear a logo. Real decoder
validation, byte and pixel bounds, animation rejection, metadata stripping,
and fixed WebP output prevent the route from serving arbitrary uploaded HTML,
SVG, or claimed media from the Crowi origin. The response's fixed content type
and global `nosniff` header are paired defenses.

The public handler accepts no storage path. It ignores the revision query for
lookup and reads one code-defined key, so it cannot enumerate arbitrary
objects. Storage errors do not cause app-info to expose internal paths or
driver messages. Its ETag, bounded byte cache, and pre-auth IP limiter bound
repeated public storage reads; `404`/error responses are explicitly
non-cacheable.

### §10.3 Theme boundary

Preset identifiers select checked-in values only. They never become CSS text,
custom-property names, URLs, or arbitrary colors. Unknown identifiers map to
`teal`.

The fixed-token boundary in §7.3 is security-relevant. A workspace theme must
not make destructive actions, success/warning states, focus, or page grants
indistinguishable. Accessibility tests cover all ten preset/mode combinations.

## §11 Alternatives considered

### §11.1 Authenticated-only branding

Rejected. It does not identify the workspace during add-workspace or login,
which is the main purpose of the feature. It is also inconsistent with the
existing public title and confidentiality notice.

### §11.2 Operator opt-in for public branding

Rejected for the first release. It adds a client-visible state and disables the
primary benefit by default. Operators that require identity secrecy need a
network access boundary, not a branding-specific switch.

### §11.3 Reuse an Attachment or hidden Page

Rejected. It would import page-grant, deletion, and authentication semantics
into public instance identity. Reusing the storage abstraction is appropriate;
reusing Attachment records and routes is not.

### §11.4 Store the logo in `User.picture`

Rejected. A workspace logo has no owning user, and the current user-picture
upload gate trusts a broad declared `image/*` type before storing the original
bytes (`packages/api/src/hono/handlers/me.ts:350-396`).

### §11.5 External logo URL or image bytes in Config

Rejected. An external URL creates tracking, mixed-origin, credential-leak, and
lifecycle problems. Bytes or data URLs bloat Config and bypass storage-driver
operations. The API-relative named object keeps identity on the workspace
origin and works across drivers.

### §11.6 Expiring signed storage URL

Rejected. App-info is cached across clients and signed URLs expire. Persisting
or caching one would make a stable workspace identity fail independently of a
branding change. The dedicated API route provides a stable origin and
an origin-controlled ETag revalidation contract.

### §11.7 Preserve arbitrary aspect ratio or store two logo variants

Rejected for the first release. Arbitrary aspect ratios complicate switcher
and compact-header layout. A separate icon and horizontal lockup double the
upload, contract, fallback, and lifecycle surface. A square icon plus title
covers both compact and wordmark-like presentations.

### §11.8 Seed- or hue-derived palettes

Rejected. The derivation algorithm, gamut clipping, contrast correction, and
platform approximation would become a long-lived public contract. Five
explicit light/dark mappings are easier to audit and keep semantically aligned
between Web and iOS.

### §11.9 Workspace-chrome-only Web theme

Rejected as the default. It lowers the visual blast radius but leaves many
ordinary action, link, focus, and selection accents identical across instances.
The chosen boundary includes existing brand-controlled semantics while keeping
functional and safety colors fixed.

### §11.10 iOS-only branding

Rejected. Browser users have the same multi-instance ambiguity in tabs, login
flows, and headers. The public contract is client-independent and should have a
consistent Web consumer.

### §11.11 Stable storage key overwritten in place

Rejected. Replacing `branding/logo.webp` before a state CAS has an unrecoverable
crash window: an uncommitted replacement can become publicly visible while the
state still names the old digest. A Redis lease cannot make local rename or S3
`PutObject` transactional with Mongo, and an expired lease cannot safely fence
a subsequent rollback. `StorageDriver.put` is unconditional and both shipped
drivers overwrite the supplied key
(`packages/plugin-api/src/registries/storage.ts:27-39`,
`packages/plugin-storage-local/src/index.ts:91-117`,
`packages/plugin-storage-aws-s3/src/index.ts:83-98`), so a writer that loses the
state CAS can still leave its bytes under the shared key. Per-put atomicity
prevents torn bytes; it does not make storage and Mongo atomic.

Note that public URL stability and storage-key mutability are separate
decisions. §4.3 already serves a stable public path backed by immutable keys,
so this RFC keeps the stable URL and its ETag revalidation while rejecting only
the shared mutable key. Immutable keys need a way to remove superseded objects,
which §4.2 provides with one durable `pendingLogoDelete` slot rather than a
storage-listing reconciler.

### §11.12 Config-backed logo CAS

Rejected. The current Config model has neither a compound unique `{ns,key}`
index nor a revision field, and its write primitive is an upsert
(`packages/api/src/models/config.ts:107-111`,
`packages/api/src/models/config.ts:154-163`). Making logo CAS reliable there
would require duplicate cleanup and an index migration across unrelated
settings. The singleton branding-state document supplies a narrow unique key
and revision without changing Config's repository-wide invariants.

## §12 Phased implementation plan

The RFC records durable architecture. Each phase requires a focused,
implementation-ready spec before code is changed.

### Phase 1: server and API contract

- Add public/admin schemas and routes, using a string public theme and strict
  admin enum.
- Add and seed the singleton `WorkspaceBrandingState` model with `theme`,
  `currentVersion`, the CAS `revision`, and `pendingLogoDelete`.
- Implement streaming aggregate-body/file enforcement, bounded decoding,
  1024×1024 WebP normalization, immutable candidate upload, state-document
  CAS, pending-delete discharge, and ETag/no-cache public delivery.
- Extend storage copy to include the committed immutable logo and the durable,
  maintenance-window copy/switch procedure of §5.4.
- Regenerate OpenAPI artifacts.
- Cover old/new client compatibility (including malformed nested branding in
  the CLI), auth, malformed images, chunked aggregate-byte/file/pixel limits,
  abort cleanup, animation, metadata stripping, fixed response headers,
  ETag/304 and no-store failures, stale revision queries, public limiting/cache
  behavior, trusted-proxy and untrusted-peer limiter identity, missing or
  corrupt objects, driver failures, candidate-put/state-CAS crash windows,
  replace/clear CAS interleavings, pending-delete discharge and retry, replica
  read-through/pub-sub invalidation, and maintenance-window storage-copy
  accounting and switch recovery.

Server support lands before either client depends on branding. This phase must
align with the general upload-policy endpoint work without treating the logo as
an Attachment.

### Phase 2: Web branding

- Add the Admin logo crop/upload/replace/clear UI and five accessible swatches.
- Add root branding synchronization and explicit light/dark preset mappings.
- Keep the five brand-state consumers in §7.2 theme-controlled; move the
  administrator badge to a fixed permission style and replace
  `PageDisplayUserBadge`'s hand-built avatar with `UserAvatar`.
- Convert all hard-coded workspace-chrome teal values, including login
  gradients/top border, to audited tokens.
- Update shared and public identity surfaces and post-discovery document titles
  with the logo/title precedence; test the documented default first paint.
- Add component, accessibility, light/dark, and visual-regression coverage for
  all presets and fixed semantic colors.

### Phase 3: iOS companion to RFC-0016

- Extend tolerant app-info decoding and the per-workspace cache.
- Add the public, credential-free, same-origin logo loader.
- Apply branding to add-workspace confirmation, switcher, and shell.
- Check in explicit native light/dark mappings for the same five identifiers.
- Test old servers, unknown presets, cross-origin URLs/redirects, offline
  behavior, missing logos, and per-workspace cache isolation.

### Phase 4: operational verification and documentation

- Document public disclosure and cache-revalidation semantics in Admin and
  operator documentation.
- Verify local and S3-compatible drivers, storage copy, and split Web/API
  origins.
- Run the complete ten-combination contrast and focus matrix on Web and iOS.
- Update RFC-0016 with a narrow normative reference to this RFC when the iOS
  phase lands.

## §13 Acceptance criteria

### §13.1 Public contract and compatibility

- Unauthenticated app-info returns `theme: "teal"` and `logoUrl: null` on an
  uncustomized installation.
- A configured logo returns the stable API-relative logo path with an opaque
  `revision` query and without a bucket or signature.
- Missing branding, unknown themes, and malformed future nested branding fields
  degrade without rejecting unrelated app-info fields in the CLI capability
  parser.
- Old clients ignore branding.

### §13.2 Authorization, normalization, and delivery

- Unauthenticated and non-admin writes receive the existing 401/403 shapes.
- Valid PNG, JPEG, and non-animated WebP inputs within limits produce one
  1024×1024 WebP with orientation applied and metadata removed.
- SVG, animation, unsupported formats, MIME spoofing, corrupt bytes, chunked
  aggregate-body/file excess, and excess decoded pixels are rejected without
  changing the active logo; parser failures and client aborts remove temporary
  files.
- The current stable logo is public with fixed WebP, `no-cache`, ETag/304, and
  `nosniff` headers; an old revision query resolves the current object, and
  every `404`/driver-error response is `Cache-Control: no-store`.
- Public logo requests are limited before storage access and repeated current
  reads use the bounded byte cache.

### §13.3 Consistency and operations

- Theme/state CAS failure and candidate-put failure preserve the serving
  invariants in §5; a failed durable write publishes no invalidation, and a
  candidate uploaded before a failed or crashed CAS is never publicly served.
- Replace/replace and replace/clear interleavings are resolved by revision CAS;
  a losing, paused, or crashed writer cannot overwrite or delete a concurrently
  published immutable object.
- Two replicas return the durable singleton state despite delayed pub/sub;
  branding writes are rejected when multi-instance subscriber readiness
  is unavailable.
- Storage copy includes the current immutable logo in dry-run and real
  accounting and completes the maintenance-window copy/switch procedure before
  it permits branding mutations again.

### §13.4 Web and iOS behavior

- Login and workspace-switch surfaces show the identity after public discovery
  and before authentication; the default product identity is an accepted,
  tested first paint while that request is pending.
- All five presets apply in light and dark mode and meet the §7.4 gates.
- The bookmark/watch/like active states, unread indicator, and notification
  heading bell follow the selected preset.
- Destructive, success, warning, chart, page-grant, administrator-role, and
  standard `UserAvatar` identity colors remain fixed.
- Logo load failure, old server, unknown preset, and offline cache miss fall
  back to Crowi identity without blocking login, workspace addition, or
  switching.
- iOS never sends a workspace Bearer token for the public logo and refuses
  cross-origin branding URLs and redirects.

## §14 Open questions

The product and architecture decisions are resolved: branding is public,
applies to Web and iOS, uses a square 1024×1024 WebP, and uses five explicit
light/dark token sets. The following implementation details remain open and
must be resolved in the indicated implementation specs:

1. **Exact decoded-pixel ceiling and decoder concurrency.** The server spec
   must choose and test a numerical pixel limit and admission/concurrency
   policy appropriate for a public 5 MiB image endpoint, reusing existing
   `sharp` controls where possible.
2. **Canonical preset values.** The Web and iOS specs must publish the exact
   light/dark values for every controlled semantic role and record the contrast
   matrix. Runtime seed derivation remains prohibited.
3. **iOS cache placement.** The iOS spec must choose whether the non-secret
   preset and revision-bearing stable logo URL live in RFC-0016's small
   workspace index or in the per-workspace app-info cache, provided they are
   available for immediate switcher rendering and remain keyed by workspace
   origin.

## §15 Resolved decisions

- Workspace branding is first-class public instance identity.
- The public boundary is `app/info` plus a dedicated stable logo route with
  ETag/`no-cache` revalidation and a revision query.
- Public disclosure on confidential instances is accepted because pre-login
  identification is the primary use case and title/confidential notice are
  already public.
- The logo is a square administrator-selected crop normalized by the server to
  1024×1024 WebP.
- Logo storage writes immutable content-addressed candidates. A singleton
  branding-state document owns `theme`, `currentVersion`, the CAS `revision`,
  and a `pendingLogoDelete` slot that makes removal of the superseded object a
  durable obligation discharged by the next administrative write. There is no
  reconciler, no storage-prefix enumeration, and no migration fence; driver
  migration relies on the operator's maintenance window.
- Web themes include workspace chrome and existing brand-controlled semantic
  accents, with a fixed functional/security/user-identity boundary.
- The initial vocabulary is five explicit, audited light/dark mappings:
  `teal`, `blue`, `indigo`, `violet`, and `rose`.
- Public theme decoding is forward-compatible string decoding; admin writes are
  strict.
- Stable-path revalidation and revision-query changes propagate replacement;
  stale revision queries resolve the current bytes, while bytes already
  received by public caches are not revocable.
