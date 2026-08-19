# @crowi/cli

## 1.0.0-alpha.5

### Patch Changes

- ee76fb4: Two or more processes refreshing the same OAuth refresh token at nearly the same time no longer forces a re-login. The server now suppresses rotation-reuse-chain revocation for a short grace window (default 60s, tunable via `OAUTH_REFRESH_REUSE_GRACE_MS`, `0` restores the previous immediate-revocation behavior) after a token is rotated away, while still returning the exact same `400 invalid_grant` response and never issuing a token on the suppressed path — reuse outside the window, and explicit `POST /oauth/revoke` calls, still revoke the whole chain exactly as before. The CLI (`crowi`) now recovers automatically on the losing side of such a race: when a refresh fails, it re-reads the locally stored profile and retries once with the refresh token a concurrent `crowi` process already rotated to, instead of surfacing a spurious session-expired error.
- Updated dependencies [c1cb3d5]
  - @crowi/api-contract@2.0.0-alpha.15

## 1.0.0-alpha.4

### Minor Changes

- 8e881d0: The server now publishes its upload policy at `GET /attachments/upload-policy` (allowed MIME types, extension-to-MIME hints, and per-route size limits), so clients no longer have to guess what an instance accepts. `@crowi/cli`'s `attach add` fetches (and caches per profile) this policy before uploading and rejects an oversized file or a disallowed type locally, instead of waiting for a 413/415 round trip; against an older server that lacks the endpoint (404), it falls back to its built-in extension table exactly as before, so nothing regresses. Profile picture uploads (`POST /me/picture`) now resolve the effective MIME type from the filename when the client doesn't declare a `Content-Type` (the same fallback already used by attachment uploads), so CLI, curl, and MCP clients can finally set a profile picture without declaring one. Profile picture acceptance also moves from an unbounded `image/*` pattern to the same finite image-type allow-list attachments use, plus a 5MB size cap matching the web client's existing crop-dialog guard; a declared `image/*` type outside that list (e.g. `image/tiff`) or a file over 5MB is now rejected, which it previously was not.

### Patch Changes

- 5096980: Attachment uploads now share a single 50 MB size limit across the "Attach file" button, editor paste, and drag-and-drop — previously these disagreed (100 MB / 10 MB / 50 MB respectively), and the paste limit in particular did nothing to bound memory usage since the request body was already fully buffered before it was checked. Operators can lower the limit with the new `CROWI_UPLOAD_MAX_BYTES` environment variable (a value above 50 MB is clamped to 50 MB, since the limit is also the per-upload memory budget); see the environment variables table in the configuration docs. `GET /attachments/upload-policy` now reports this single limit as `maxBytes.attachment` (the separate `paste`/`dnd` figures are gone), and the editor upload request no longer sends an `intent` field — the web drag-and-drop handler now reads its size ceiling from this policy response instead of a hard-coded constant. If a reverse proxy sits in front of crowi and rejects an upload with its own (smaller) body-size limit before the request reaches the api, the web editor and the `crowi attach add` CLI command now recognize that the rejection didn't come from crowi itself and tell the user to check the proxy configuration instead of reporting crowi's own limit; the deployment docs gained a section on setting the proxy's body-size limit (nginx defaults to 1 MB) to a margin above crowi's own limit, since an exact match can still reject a request crowi would have accepted.
- Updated dependencies [cb0608a]
- Updated dependencies [8e881d0]
- Updated dependencies [5096980]
  - @crowi/api-contract@2.0.0-alpha.14

## 1.0.0-alpha.3

### Patch Changes

- f855266: `crowi attach download <id>` downloads one attachment — to a file with `-o`, or to stdout so it can be piped. `crowi attach list` now prints the attachment id at the start of each row, which is what the new command takes. It is served by a new `GET /api/attachments/{id}/download`, a strict counterpart to the delivery routes an embedded `<img>` uses: those answer a missing attachment with the placeholder image and a `200`, which a client extracting bytes cannot tell apart from the real file, whereas this route returns `404` for both a missing record (`ATTACHMENT_NOT_FOUND`) and a missing stored object (`FILE_MISSING`). The CLI also validates the response before writing anything, and removes a partial file if the transfer is cut short, so a saved file is always the whole attachment.
- 070844f: `crowi --version` now reports the version you actually have installed. It printed a hardcoded `0.1.0-dev` — the string the package was scaffolded with — for every release since, so the one command you run to answer "what version are you on?" could not answer it.
- Updated dependencies [9a06104]
- Updated dependencies [0b2656a]
- Updated dependencies [0b62bc0]
  - @crowi/api-contract@2.0.0-alpha.13

## 1.0.0-alpha.2

### Minor Changes

- 52b3556: The global flags (`-p, --profile <alias>`, `--url`, `--token`, `--json`, `-q`) now appear in every subcommand's `--help` under a "Global Options" heading, so `crowi login --help` finally tells you `--profile` exists. The flags themselves are unchanged: they have always been accepted either before or after the command name (`crowi login <url> --profile work` and `crowi --profile work login <url>` both work), with the later occurrence winning when given on both sides. Added `crowi profiles use <alias>` to switch the current/default profile — an unknown alias leaves the config untouched and exits with code `4`. `crowi profiles` now also prints a stderr-only hint on how to switch the current profile; the `--json` output shape is unchanged.

### Patch Changes

- Updated dependencies [d4342cd]
- Updated dependencies [c5f243a]
- Updated dependencies [8b42663]
- Updated dependencies [f6a3ffe]
  - @crowi/api-contract@2.0.0-alpha.12

## 1.0.0-alpha.1

### Major Changes

- ce69b4a: BREAKING: the public API namespace moves from `/api/v2` to `/api`. `v2` never
  carried real version-negotiation meaning (contracts are root-relative, the
  segment was stripped verbatim at the listener boundary), and Crowi 2.0 has no
  production deployments and no parallel API generations left to protect — see
  `docs/rfcs/0006-hono-integration.md` for the framework migration that made the
  old `/api/v2/*` HTTP shape a fixed point in the first place. There is no
  server-side alias or redirect for `/api/v2/*`: after upgrading, every request
  to the old prefix returns a plain 404.

  **MCP clients** (Claude Desktop, Codex CLI, or any other client with a Crowi
  MCP server URL configured directly — including anyone who followed the
  "MCP setup" card on the user settings page before this release) must update
  the endpoint from `<host>/api/v2/mcp` to `<host>/api/mcp`. Existing PAT /
  OAuth credentials are unaffected — only the connection URL changes.

  **`@crowi/cli` users** must upgrade to this release (or later) in the same
  deploy as the api. An un-upgraded CLI will 404 against the new listener; on
  `crowi logout`, the CLI now also warns (rather than silently succeeding) when
  the cached OAuth revoke endpoint returns a non-2xx status, since local
  credentials are removed regardless — re-run `crowi login` or ask an
  administrator to revoke the stale token server-side.

  **Operators running multiple api replicas** must treat this as a coordinated
  fleet cutover, not a normal one-at-a-time rolling restart: the old and new
  listeners cannot interpret each other's prefix, so any deploy topology that
  lets old and new api replicas serve traffic at the same time causes 404s for
  whichever client hits the "wrong" generation. Stop all api replicas and start
  them back up together on the new version (or cut a blue/green fleet over as a
  single step), and use the preflight check (`GET /api/openapi.json` returns
  200, `GET /api/v2/openapi.json` returns 404 on every replica before accepting
  traffic) documented in the new "api prefix cutover" section of
  `operations/self-hosting`. Single-instance deployments (including local dev)
  are unaffected by this requirement — there is only one replica, so old/new
  never coexist.

  Everything else about the HTTP surface is unchanged: route paths, request/
  response shapes, auth, and scopes are identical under the new prefix. Browser
  users see no visible change (the web app talks in same-origin relative paths
  and picks up the new base URL on next build), except that a tab left open
  since before the cutover will 404 on API calls until reloaded. Attachment /
  avatar URLs already embedded in page bodies keep resolving via permanent
  canonicalization on both the server (attachment lookup) and the web client
  (display-time URL rewrite) — no database migration is required or performed.

### Patch Changes

- e2c5eed: `crowi attach add` now declares the file's media type when uploading, so an uploaded image is stored as an image instead of `application/octet-stream`. Previously the multipart part carried no type, and since attachment delivery only serves an allow-listed type inline, a PNG uploaded through the CLI came back as a download. Attachments already uploaded keep their recorded `application/octet-stream` type — re-upload them to correct it.
- Updated dependencies [ce69b4a]
- Updated dependencies [4736e06]
- Updated dependencies [7a7394f]
  - @crowi/api-contract@2.0.0-alpha.11

## 0.1.0-alpha.0

### Minor Changes

- 6a78e18: Add `@crowi/cli`, the end-user command-line interface for Crowi (RFC-0012). The
  `crowi` binary talks to a Crowi server over HTTP and is distinct from
  `@crowi/admin-cli`, which connects directly to MongoDB for operators.

  Authentication uses the first-party public OAuth client (RFC-0010) with PKCE —
  no client secret. Three login flows are supported: browser authorization-code
  over an ephemeral loopback redirect (default), the device-authorization grant
  for headless / SSH sessions (`--device`), and storing a pre-issued personal
  access token directly. Tokens are persisted as plain JSON at
  `~/.config/crowi/contexts.json` (honouring `$XDG_CONFIG_HOME`) with file mode
  `0600`, and a 401 transparently triggers a single coalesced refresh + retry.
  Multiple servers / accounts are managed as named profiles.

  Commands cover reading (`search`, `get`/`cat`, `ls`), writing (`create`,
  `edit`, `update`, `mv`, `rm` — with optimistic-lock conflict handling that
  aborts by default and only overwrites with `--force`), and, behind their own
  OAuth scopes, `comment`, `attach`, `bookmark`, `watch`, and `open`. Outgoing
  arguments are validated against the shared request contracts before any call
  leaves the machine, while responses are parsed leniently so the CLI tolerates
  version drift across self-hosted instances; it reads the `GET /api/v2/app/info`
  version / capability signal to warn (never refuse) on skew and to pre-empt
  disabled features. `--json` and `--template` output make commands scriptable,
  `crowi completion <bash|zsh|fish>` emits shell completions, and
  `pnpm --filter @crowi/cli build:binary` produces a standalone single-file
  executable.

### Patch Changes

- Updated dependencies [0e9a07c]
  - @crowi/api-contract@2.0.0-alpha.1
