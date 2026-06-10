# RFC-0012: Crowi CLI (`@crowi/cli`) — end-user command-line client

- **Status**: Draft
- **Author**: (you)
- **Created**: 2026-06-06
- **Depends on**:
  - RFC-0010 (OAuth 2.0 & Scoped API Access) — the seeded first-party
    `crowi-cli` **public** OAuth client (PKCE, loopback redirects, device flow),
    discovery, PAT, and the `SCOPES` catalog. The CLI is the intended consumer
    this client was created for.
  - `@crowi/api-contract` — the typed Hono RPC client (`createClient`) + Zod
    schemas, reused for all API calls and argument validation.
- **Related**:
  - `@crowi/admin-cli` (`crowi-admin`) — operator-side, **DB-direct**. This RFC
    is the **end-user, HTTP-API** CLI it explicitly defers to (see that
    package's description). Disjoint tools.
  - RFC-0011 (Crowi MCP) — a sibling API consumer (for AI clients). Both reuse
    api-contract + RFC-0010 auth; see §9 on a shared OAuth-client core.
- **Companion change (small, server-side)**: a reliable **instance-version
  signal** is needed for version-skew handling (§3.4) — there is none today
  (`/app/info` returns only `{ title }`; OpenAPI `info.version` is hard-coded).
  Overlaps the alpha1 release prep's open question about syncing the OpenAPI
  version (`.feature-state/specs/feature-v2-alpha1-release-prep.md`).

## §0 Summary

`@crowi/cli` is a publishable, install-anywhere command-line tool (`crowi …`)
that lets a human create, edit, search, and manage wiki pages from the
terminal. It talks to a Crowi instance **only over the HTTP API** (`/api/v2`),
authenticating **as the user** via the seeded `crowi-cli` OAuth client
(RFC-0010): `crowi login` runs the Authorization-Code + PKCE **loopback** flow
(opens a browser, captures the callback on an ephemeral `127.0.0.1` port),
auto-falling back to the **device flow** when no browser is available, and
accepting a **PAT** for CI. Tokens are stored per **profile** in
`~/.config/crowi/config.json`, so one CLI can target multiple Crowi instances.

v1 ships page **read + write + search + `edit`** commands. All API calls and
argument schemas reuse `@crowi/api-contract`, so the CLI stays in lockstep with
the server contract.

## §1 Background / Motivation

- Power users and scripts want to operate the wiki without the web UI: grep-like
  search, `cat` a page, pipe a file into a new page, edit in `$EDITOR`, move /
  delete pages, automate doc publishing in CI.
- RFC-0010 already **seeded the `crowi-cli` OAuth client** (public, PKCE,
  loopback `http://127.0.0.1`/`http://localhost`, device flow, all
  `ISSUABLE_SCOPES`) and shipped discovery + token + device endpoints. The auth
  story is designed; this RFC builds the actual binary.
- `@crowi/api-contract` exposes `createClient(baseUrl, { headers | fetch })` and
  all request/response Zod schemas, so the CLI is mostly **command surface +
  auth/token plumbing + I/O ergonomics**, not new protocol work.

### §1.1 Why a separate tool from `@crowi/admin-cli`

| | `@crowi/admin-cli` (`crowi-admin`) | `@crowi/cli` (`crowi`) — this RFC |
|---|---|---|
| Audience | operator / sysadmin | end user |
| Transport | **MongoDB direct** (Mongoose) | **HTTP `/api/v2`** |
| Auth | runs on the server host | OAuth (per-user) / PAT |
| Depends on | `@crowi/api` (DB bootstrap) | `@crowi/api-contract` only |
| Examples | migrate / rebuild / storage copy | search / get / create / edit |

They share nothing at runtime and ship as separate npm packages.

## §2 Goals / Non-Goals

### §2.1 Goals

- A `crowi` binary published as `@crowi/cli`, installable via
  `npm i -g @crowi/cli` or `npx @crowi/cli`.
- `crowi login` — Auth-Code + PKCE loopback (primary), device-flow fallback,
  PAT (`--token` / `CROWI_TOKEN`) for CI. Token refresh + `crowi logout`
  (revoke).
- **Multi-profile** config (`--profile`, `~/.config/crowi/config.json`) so one
  install targets several Crowi instances **running different versions** —
  version-skew tolerant (see §3.4): lenient response parsing + per-profile
  capability/version detection, like `kubectl` against clusters of differing
  versions (and `gh` against github.com vs Enterprise Server).
- v1 commands: `search`, `get`/`cat`, `ls`, `create`, `edit` (`$EDITOR`),
  `update`, `mv` (rename), `rm` (delete) + `whoami`. Human output by default,
  `--json` for scripting.
- Reuse `@crowi/api-contract` **as the v2 contract floor** (request shapes +
  endpoint set) and reuse RFC-0010 for all auth — without hard-baking a single
  schema version into the client (§3.3).

### §2.2 Non-Goals

- **Admin operations** — `admin:*` scopes are unissuable to OAuth/PAT clients
  (RFC-0010); admin stays in `crowi-admin`.
- **DB access** — HTTP only.
- **Comments / attachments / bookmarks / watch** — Phase 2 (§10).
- **Realtime collab** from the CLI — out of scope.
- **Shell completions / TUI** — Phase 3.

## §3 Architecture

```
crowi <cmd>  ──reads──►  ~/.config/crowi/config.json  (profiles: url + tokens + cached version/caps)
   │
   │ per-profile: resolve {url, token}; (cached) instance version + capabilities
   │ requests built from api-contract v2 request schemas (validate own input)
   │ authedFetch: inject `Authorization: Bearer <access>`, refresh on 401
   │ responses parsed LENIENTLY (read needed fields; ignore unknown) — §3.3
   ▼
Crowi HTTP API (/api/v2)  ── createJwtAuth / requireScope (RFC-0010) ──► handlers
```

- **No `@crowi/api` dependency.** The CLI imports `@crowi/api-contract` for the
  **v2 contract floor** (request shapes + the endpoint set it knows) and uses
  RFC-0010 for auth. The MCP SDK is irrelevant here.
- **Framework**: `commander` (same as `admin-cli`), one file per command group.
- **HTTP client**: a thin `authedFetch` wrapper that injects the bearer token
  and transparently refreshes on `401` (mirrors
  `packages/web/src/lib/api-client.ts`'s `apiV2Fetch` 401→refresh→retry, but via
  the OAuth refresh-token grant). See §3.3 for *why it is a lenient hand-written
  layer, not a strictly-typed baked client*.

### §3.3 HTTP layer: lenient, not a baked strict client

A CLI that targets **many instances of differing versions** must not bake a
single compile-time schema and hard-fail on drift. Two tempting options are
both wrong on their own:

- the api-contract **`hc<AppType>` RPC client** bakes one schema, is a huge
  intersection type (the package itself notes TS2589 depth issues), and would
  reject / mistype responses from a newer or older instance;
- a **single OpenAPI-generated strict client** likewise freezes one version.

Instead:

- **Requests** are built from the **api-contract Zod request schemas** (the v2
  floor the CLI knows) — these validate the CLI's *own* input before sending.
- **Responses** are parsed **leniently**: read only the fields each command
  needs; **ignore unknown/extra fields** (newer instance) and tolerate missing
  optional ones (older instance). No strict `.strict()` Zod gate on responses.
- This makes one CLI build work across a *range* of v2 instances — the same
  property that lets `kubectl` talk to clusters within a version skew and `gh`
  talk to both github.com and Enterprise Server.

### §3.4 Version & schema compatibility (multi-profile / version skew)

- **`/api/v2` is the compatibility boundary.** Within v2 the server commits to
  **additive, backward-compatible** changes (new endpoints / optional fields);
  a breaking change means `/api/v3`. The CLI targets v2 and degrades gracefully
  within it.
- **Per-profile capability/version detection** (cached per profile, with a TTL /
  ETag), `kubectl`-style:
  - read the instance **version** (see *server prerequisite* below) → on an
    unsupported skew, **warn** ("CLI vX may not fully support instance vY") but
    still attempt;
  - optionally fetch the instance's **live `GET /api/v2/openapi.json`** (already
    served by every instance via `doc31('/openapi.json', …)`) to **feature-gate**
    commands — i.e. detect whether the target advertises an endpoint/param
    before offering it.
- **Graceful degradation**: when a command's endpoint/field is absent on the
  target (e.g. a `404` for a route a newer CLI knows but an older instance
  lacks), surface a clear *"your Crowi instance (vY) doesn't support `crowi
  <cmd>`; requires ≥ vZ"* rather than a raw error.
- **Server prerequisite (companion change)**: there is currently **no reliable
  instance-version signal** — `GET /api/v2/app/info` returns only `{ title }`
  and the OpenAPI `info.version` is hard-coded `'2.0.0'`
  (`packages/api/src/hono/index.ts:197`). Add one of: a `version` (and maybe
  `apiVersion`) field to `/app/info`, or make `openapi.json`'s `info.version`
  track the real package version (already flagged by the alpha1 release RFC's
  open question). The CLI reads whichever lands. **This RFC depends on that
  small addition** for skew warnings; lenient parsing (§3.3) works regardless.
- **Scope**: v1 ships **lenient parsing + version read + warn + degrade on
  404**. Full OpenAPI-driven feature-gating / dynamic command availability
  (the `kubectl explain` end-state) is **Phase 2** (§10).

## §4 Authentication & token lifecycle

### §4.1 `crowi login` (primary: Auth-Code + PKCE loopback)

1. Resolve the instance URL (`--url`, else prompt, else `CROWI_URL`) and fetch
   `GET {url}/.well-known/oauth-authorization-server` (RFC-0010 discovery) to
   learn the `authorization_endpoint` / `token_endpoint` / scopes.
2. Generate PKCE (`code_verifier` + S256 `code_challenge`) and a random
   `state`. Start a throwaway HTTP server on an ephemeral `127.0.0.1:<port>`;
   the `redirect_uri` is `http://127.0.0.1:<port>/callback` (matched against the
   seeded loopback `redirectUris` by `util/oauth-redirect-uri.ts`).
3. Open the browser to `authorization_endpoint?client_id=crowi-cli&
   response_type=code&scope=…&code_challenge=…&state=…&redirect_uri=…`.
4. The user consents in the Next.js consent screen; the browser redirects to the
   loopback `/callback?code=…&state=…`. The CLI validates `state`, shuts the
   server, and shows "you can close this tab".
5. Exchange at `token_endpoint` (`grant_type=authorization_code`, `code`,
   `code_verifier`, `redirect_uri`, `client_id=crowi-cli`) → `{ access_token,
   refresh_token, expires_in, scope }`.
6. Persist to the profile (§5). Default scope request:
   **`pages:read pages:write`** (override with `--scope`).

### §4.2 Device-flow fallback (`--device`, or auto when headless)

When no browser can be opened (no `$DISPLAY`/SSH, or `--device`):
1. `POST {api}/oauth/device/authorize` (client_id + scope) → `user_code`,
   `verification_uri`, `device_code`, `interval`, `expires_in`.
2. Print: "Open {verification_uri} and enter: ABCD-1234".
3. Poll `POST {api}/oauth/token` (`grant_type=urn:…:device_code`) honoring
   `interval` / `slow_down` until `approved` (→ tokens) / `denied` / `expired`.

### §4.3 PAT mode (CI / headless scripts)

`crowi login --token crowi_pat_…` (or `CROWI_TOKEN` env) stores the PAT as the
profile's credential, skipping OAuth entirely. No refresh (PAT is long-lived /
revoked from the web UI). Ideal for CI.

### §4.4 Refresh & logout

- On a `401` mid-command, the `authedFetch` wrapper runs the **refresh-token
  grant** (`grant_type=refresh_token`, rotation per RFC-0010), persists the
  rotated tokens, and retries once. If refresh fails → instruct `crowi login`.
- `crowi logout [--profile]` calls `POST {api}/oauth/revoke` on the refresh
  token (RFC 7009) and clears the profile's credentials.
- PAT profiles: `logout` just clears local storage (revoke PATs from the web UI).

## §5 Config & profiles

- File: **`~/.config/crowi/config.json`** (XDG; `$XDG_CONFIG_HOME` honored),
  written with `0600` perms (contains tokens).
- Shape:
  ```jsonc
  {
    "defaultProfile": "personal",
    "profiles": {
      "personal": {
        "url": "https://wiki.example.com",
        "auth": { "kind": "oauth", "accessToken": "…", "refreshToken": "…",
                  "expiresAt": "2026-06-06T12:00:00Z", "scope": "pages:read pages:write" }
      },
      "work": { "url": "https://wiki.work.example", "auth": { "kind": "pat", "token": "crowi_pat_…" } }
    }
  }
  ```
- Selection precedence (per invocation): `--profile` → `CROWI_PROFILE` →
  `defaultProfile`. `--url` / `CROWI_URL` / `--token` / `CROWI_TOKEN` override
  the resolved profile's fields (handy for one-off / CI without writing config).
- `crowi profiles` (list), `crowi login --profile <name>` (add/refresh),
  `crowi logout --profile <name>` (remove).

## §6 Command surface (v1)

Global flags: `--profile <name>`, `--url <url>`, `--token <pat>`, `--json`,
`--quiet`. Human-friendly output by default; `--json` emits the raw API JSON for
scripting. Exit non-zero on error (mapped from the API error envelope's
`error.code` / `error.message`).

| Command | API (dispatched) | Notes |
|---|---|---|
| `crowi login [--profile][--device][--token][--url][--scope]` | discovery + `/oauth/*` | §4 |
| `crowi logout [--profile]` | `/oauth/revoke` | §4.4 |
| `crowi whoami` | `GET /me` | shows user + active scopes |
| `crowi profiles` | (local) | list configured profiles |
| `crowi search <query> [--limit][--json]` | `GET /search` | prints `path — snippet` rows |
| `crowi get <path\|id> [--revision][--json]` | `GET /pages` | prints the markdown body to stdout (pipe-friendly); `--json` for meta |
| `crowi cat <path>` | alias of `get` | |
| `crowi ls [path] [--json]` | `GET /pages/children` (or `/pages/list`) | child pages under a path |
| `crowi create <path> [-m <text> \| -f <file> \| --stdin] [--grant]` | `POST /pages` | body from `-m` / file / stdin / `$EDITOR` if none |
| `crowi edit <path> [--editor <bin>]` | `GET /pages` → `$EDITOR` → `PUT /pages` | §7 |
| `crowi update <path> (-m\|-f\|--stdin)` | `PUT /pages` | non-interactive body replace (revision-locked) |
| `crowi mv <old> <new> [--no-redirect]` | `POST /pages/rename` | rename/move |
| `crowi rm <path> [--completely]` | `DELETE /pages` | soft-delete (trash) by default |

> Input args are validated with the matching api-contract Zod schema before the
> call, so the CLI gives clear local errors (e.g. bad path) without a round-trip.

## §7 `crowi edit` (the interactive editor flow)

1. `GET /pages?path=<path>` — if found, capture `body` + `revision_id`; if 404,
   start from an empty buffer (create-on-save).
2. Write the body to a temp file (`*.md`), open `$EDITOR` (or `--editor` /
   `$VISUAL`), wait for exit.
3. If unchanged → no-op. If changed:
   - existing page → `PUT /pages` with `{ page_id, body, revision_id }`
     (optimistic lock).
   - new page → `POST /pages` with `{ path, body }`.
4. **Conflict (`409`)**: someone edited the page while the editor was open.
   Re-fetch, show a diff, and offer: keep editing on the new base / overwrite /
   abort (default abort). Never silently clobber.

## §8 Reuse strategy

| Concern | Reused from | How |
|---|---|---|
| HTTP transport | thin `authedFetch` (own) | bearer inject + 401→refresh; **lenient response parsing** (§3.3) |
| Request shapes / arg validation | api-contract Zod **request** schemas | parse CLI args → `CreatePageRequestSchema` etc. before sending (the v2 floor) |
| Endpoint set / paths | api-contract contracts | the routes the CLI knows; responses read leniently, not strictly typed |
| Instance version / capabilities | live `GET /api/v2/openapi.json` + a version signal | per-profile cache; warn on skew, feature-gate (§3.4) |
| Auth (OAuth client, discovery, device, PAT, scopes) | RFC-0010 | the CLI is the `crowi-cli` client; nothing server-side to add |
| 401→refresh→retry | `packages/web/src/lib/api-client.ts` (pattern) | same shape, OAuth refresh grant instead of session refresh |
| Package/build template | `@crowi/admin-cli` | commander + tsup + `bin` + `publishConfig` (but no `@crowi/api` dep) |

## §9 Packaging

- New package **`packages/cli`** → `@crowi/cli`, `version 0.1.0-dev`,
  `publishConfig.access: public`.
- **Binary**: `crowi` (clean primary command). If a global-install name clash is
  a concern, `crowi-cli` is the fallback alias; ship `bin: { "crowi": …,
  "crowi-cli": … }` pointing at the same entry (decide in §11).
- **Build**: `tsup` (CJS, `bin.ts` + lib entry), `dts` for the lib; `app-node`
  tsconfig.
- **Deps**: `@crowi/api-contract` (`workspace:^`), `commander`, `open` (browser
  launch), `dotenv` (optional). **No `@crowi/api`.**
- **Changesets**: standalone package; not in the `api/web/api-contract` linked
  group (it bumps independently). Add a changeset on first release.
- Distribution: `npx @crowi/cli` / global install. (A Homebrew tap / single-file
  binary via `pkg`/`bun build --compile` is a possible Phase 3 convenience.)

## §10 Rollout phases

- **Phase 1** (this RFC's core): `login` (loopback + device + PAT) + config /
  profiles + `whoami` / `search` / `get` / `ls` / `create` / `edit` / `update`
  / `mv` / `rm` + `--json`. **Lenient response parsing + per-profile instance
  version read + skew warning + degrade-on-404** (§3.3–§3.4). Requires the
  companion server version signal. Smoke-tested against a local instance.
- **Phase 2**: OpenAPI-driven **capability detection** (fetch/cache the
  target's `openapi.json`, feature-gate commands per instance); comments /
  attachments (`crowi attach`) / bookmarks / watch (behind their scopes);
  `crowi open <path>` (open in browser).
- **Phase 3**: shell completions, single-file binary, richer piping
  (`crowi search … | crowi get -`), output templates.

## §11 Open questions

1. **Binary name** — `crowi` (clean, but may collide on `$PATH`) vs `crowi-cli`.
   Lean: ship both `bin` names → same entry; document `crowi` as primary.
2. **Default login scopes** — `pages:read pages:write` (proposed) vs prompt the
   user to pick vs request umbrella `read write`. Narrower is safer; `--scope`
   overrides.
3. **`edit` conflict UX (§7)** — diff+choose vs always abort on 409. Proposed:
   abort by default, `--force` to overwrite.
4. **Shared OAuth-client core** — extract the device/auth-code/PKCE/refresh
   logic into a small `@crowi/oauth-client` lib reusable by the CLI now and a
   possible future standalone MCP-stdio wrapper? Or keep it inside `@crowi/cli`
   for v1 (extract later if a second consumer appears). Lean: keep in-CLI for v1.
5. **Token storage hardening** — plain `0600` JSON vs OS keychain
   (`keytar`-style) for the access/refresh tokens. Proposed: `0600` JSON in v1,
   keychain as an opt-in Phase 2.
6. **renameTree** — `crowi mv` gains a `--recursive` once `feature-rename-tree`
   lands.
7. **Instance version signal (companion server change, §3.4)** — add `version`
   (+ maybe `apiVersion`) to `GET /api/v2/app/info`, or sync `openapi.json`'s
   `info.version` to the package version (already an alpha1-RFC open question),
   or a dedicated `/version`. Decide which the CLI reads. **Blocking for skew
   warnings; non-blocking for lenient parsing.**
8. **Supported skew policy** — how wide a CLI↔instance version gap to *support*
   vs *warn* vs *refuse* (kubectl uses ±1 minor). Crowi is pre-1.0; likely
   "warn only" until the API stabilizes.
9. **Capability-cache invalidation** — TTL / ETag for the cached per-profile
   version + openapi; when to re-fetch (e.g. on a surprising `404`).

## §12 References

- RFC-0010 (OAuth/PAT/scopes; the seeded `crowi-cli` client + device flow +
  discovery), RFC-0011 (MCP — sibling consumer).
- Code: `packages/api/src/util/oauth-client-seed.ts` (the `crowi-cli` client),
  `packages/api/src/hono/handlers/oauth.ts` (authorize / token / device /
  discovery), `packages/api/src/util/oauth-redirect-uri.ts` (loopback port
  matching), `packages/api-contract/src/client.ts` (`createClient`),
  `packages/api-contract/src/schemas/*` (arg schemas),
  `packages/web/src/lib/api-client.ts` (401→refresh pattern),
  `packages/admin-cli/*` (package/build template),
  `packages/api/src/hono/index.ts:192-197` (live `/api/v2/openapi.json` +
  hard-coded `info.version`), `packages/api-contract/src/schemas/app.ts`
  (`AppInfoResponseSchema` — currently `{ title }` only, needs a `version`).
- Prior art: `kubectl` (runtime API discovery + version skew tolerance),
  `gh` (github.com vs Enterprise Server compatibility).
