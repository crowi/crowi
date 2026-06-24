# RFC-0016: Native Apple app for Crowi (multi-workspace; iPhone/iPad v1, macOS-ready)

- **Status**: Draft
- **Author**: @sotarok
- **Created**: 2026-06-23
- **Depends on**:
  - `@crowi/api-contract` — the committed OpenAPI document
    (`packages/api-contract/openapi.json`, OpenAPI 3.1.0) is the single build
    input the Swift request/path layer is generated from, and the Zod schemas
    define every response shape the app reads.
  - The existing OAuth 2.0 Authorization-Code + PKCE stack — the web authorize
    page (`packages/web/src/app/(auth)/oauth/authorize/page.tsx`), the JSON
    authorize/token handlers (`packages/api/src/hono/handlers/oauth.ts:166-222,223+`),
    the RFC 8414 discovery document (`oauth.ts:385-404`), and the redirect
    validator (`packages/api/src/util/oauth-redirect-uri.ts:34-53`) — the **sole
    v1 auth path** (§4). v1 carries a **bounded set of server companion changes**
    (seed a `trusted` `crowi-ios` client + custom-scheme redirect, relax the
    redirect validator for trusted clients, and wire the reserved `trusted` flag
    to auto-approve in **both** the API and the web authorize page, §4.4), which
    **ship together in the minimum Crowi version**, so there is no per-host
    operator action.
  - The public, unauthenticated `GET /api/v2/app/info`
    (`packages/api-contract/src/schemas/app.ts:39-46`) for "is this a Crowi
    server?" validation and per-host capability/version detection — including
    deciding whether a host meets the §4.4 minimum version.
- **Related**:
  - RFC-0012 (`@crowi/cli`) — the closest sibling: a native, end-user,
    HTTP-only, multi-profile client targeting N Crowi hosts of differing
    versions. This RFC reuses its multi-profile mental model verbatim
    (profile → workspace) for the multi-workspace layer (§3) and its
    lenient-version-skew policy (§5).
  - RFC-0011 (Crowi MCP) — a sibling first-party `/api/v2` consumer. The app
    is the third such surface after the CLI and MCP; all three treat
    `/api/v2` as the contract floor.
  - RFC-0010 (OAuth 2.0 & Scoped API Access) — the **substrate v1 auth is built
    on**: the Authorization-Code + PKCE flow, RFC 8414 discovery, redirect
    validation, the rotating/reuse-detected refresh token, and scoped access
    tokens (§4). v1 adds a `trusted` `crowi-ios` client + a custom-scheme redirect
    to it (§4.4); the seeded-client flow the CLI
    uses (`crowi-cli`) is the direct model.
  - RFC-0014 (Auth Provider Plugins) — inbound SSO / social / enterprise IdP for
    the **host's** login page. Because v1 authenticates on that page inside the
    OAuth webview (§4.5), any RFC-0014 provider the host enables works with **no
    app change**; RFC-0014 is a dependency of the host, not of this app.
  - RFC-0003 (Realtime Collaborative Editing) — the collab path the app
    **does not** use; v1 edits via the REST optimistic-lock channel instead
    (§8). RFC-0009 (revision storage) is where those revisions land.

## §0 Summary

A native Apple application that lets a person read and lightly edit a Crowi
wiki from iPhone and iPad, across **multiple independent Crowi workspaces**
(Slack-style: one app, N hosts, each a possibly-different Crowi version and
each independently signed in). It is a fourth first-party client surface after
the web app, `@crowi/cli` (RFC-0012), and MCP (RFC-0011), and like those it
talks to a Crowi instance **only over the HTTP API** (`/api/v2`).

The architectural commitments:

1. **CLI-shaped, read-first + bounded write.** v1 ships the full **read**
   surface (pages, hierarchy / portals / children, full-text search,
   revisions, comments, bookmarks / likes / seen, backlinks, profile,
   poll-based notifications) **plus a bounded write surface** (create and
   quick-edit pages via the existing REST endpoints with `revision_id`
   optimistic locking, comment creation, and engagement toggles). No realtime
   collaboration — the app accepts the same last-write-wins caveat the CLI and
   raw API already have, and surfaces revision conflicts explicitly (§8).
2. **OAuth 2.0 (Authorization Code + PKCE) per workspace — the only v1 auth.**
   Each workspace signs in via an `ASWebAuthenticationSession` that runs the
   OAuth Authorization-Code + PKCE flow with a **custom-scheme callback**
   (`crowi-ios://callback`) against a **server-seeded, first-party, `trusted`
   `crowi-ios` OAuth client** — so the **consent screen is skipped** and the user
   authenticates on **the host's own login page** (email/password today, or any
   future SSO / auth-provider plugin per RFC-0014, with **no app change**). The
   app resolves endpoints via **RFC 8414 discovery** (the authorization page is a
   web-origin page; the token endpoint is under `/api/v2`, possibly a different
   origin — §4.1) and **never handles the raw password**. The credential is the
   OAuth access + refresh token pair: **rotating, reuse-detected, DB-stored,
   individually revocable per workspace/device, and scope-bounded** — the app
   requests its scopes (e.g. `pages:read pages:write`) at authorize time
   (`packages/api/src/hono/handlers/oauth.ts:172`), so it **never hits
   `403 INSUFFICIENT_SCOPE`**, and **logout revokes the refresh token
   server-side** (a real kill switch, unlike a stateless JWT). v1 carries a
   **bounded set of server companion changes** spanning the API *and* the web app
   — seed the `crowi-ios` client + custom-scheme redirect, relax the redirect
   validator for trusted clients, and wire the reserved-but-inert `trusted` flag
   to auto-approve (§4.4) — which **ship together in the minimum supported Crowi
   version**, so there is **no per-host operator
   action**. A host older than that floor cannot be added (no password
   fallback); the version is detected from `/app/info` (§3 / §4.4). **No
   password-login path, no PAT in v1.**
3. **Hybrid typed client.** Request types and paths are generated from the
   in-tree `packages/api-contract/openapi.json` with
   [swift-openapi-generator](https://github.com/apple/swift-openapi-generator),
   but responses are decoded **leniently** (unknown / missing fields tolerated)
   so one app build can talk to N hosts of differing Crowi versions (§5).
4. **Multiplatform-ready from day one.** A single SwiftUI source targets
   iPhone + iPad as a universal app in v1; macOS (and later visionOS) are
   future destinations reached from the *same* source via an Xcode
   multiplatform target plus modest OS-conditional idiom deltas — never a
   second source tree (§9).
5. **In the monorepo as a tooling island.** The app lives at `apps/apple/`;
   because it has no `package.json` it is outside the pnpm workspace and turbo
   task graph, so turbo never builds/tests/caches the **Swift** sources (Xcode /
   SwiftPM own the Apple build, behind a path-gated macOS CI job). The carve-out
   is `package.json`-scoped, **not** path-scoped: the repo's file-glob Biome +
   lefthook format/lint **do** still reach any `.ts/.js` tooling file placed in
   the directory (§10) — accepted, and tracked by OQ-5. The shared build input
   is the in-tree `openapi.json`, consumed directly, so contract + client can
   change atomically with no pinning or drift.

Persistence is **SwiftData** with a **per-workspace `ModelContainer`** for
physical cache isolation between hosts; the platform floor is **iOS 17 /
macOS 14 (Sonoma)** (§7). Markdown is rendered **natively** from the raw
`revision.body` (§6) — the server's `renderedAst` is web-coupled and is not
consumed.

## §1 Background / Motivation

- Crowi today has exactly one rich client (the Next.js web app) plus two
  headless ones (`@crowi/cli`, MCP). There is no first-class way to read a
  wiki on a phone, capture a quick note, or skim search results away from a
  desktop browser. A wiki is a reference and capture tool; the mobile gap is
  the obvious missing surface.
- The plumbing a native client needs already exists and is stable:
  - the entire read + bounded-write REST surface under `/api/v2`
    (`packages/api-contract/src/contracts/*`), unchanged by this RFC;
  - a public version/capability probe at `GET /api/v2/app/info`
    (`packages/api-contract/src/schemas/app.ts:39-46`) that returns
    `{ title, confidential, version, apiVersion, capabilities[], canSelfRegister }`;
  - a committed OpenAPI 3.1.0 document (`packages/api-contract/openapi.json`,
    CI-enforced by `pnpm check:openapi`) that
    [swift-openapi-generator](https://github.com/apple/swift-openapi-generator)
    can turn into a typed Swift client;
  - CORS that allows requests with **no `Origin`** header
    (`packages/api/src/hono/middleware/cors.ts:1-15` — the policy comment
    explicitly lists "mobile clients"), so a native URLSession needs no
    Origin and is a first-class citizen of the API.
- The work is therefore overwhelmingly **client-side application code**:
  a multi-workspace shell, per-host auth/token plumbing, a lenient typed
  client, native rendering, and SwiftData caching. The server contract is
  consumed as-is.

### §1.1 Why an RFC, and why a native (not cross-platform) client

This is precedent-setting and cross-cutting: it adds a new client surface with
durable architectural commitments (the multi-workspace isolation model, the
deferred-collab edit path, the deferred-APNs notification model, the
in-monorepo tooling-island layout). It mirrors RFC-0012 and RFC-0011 in shape
and belongs alongside them.

The client technology is **native Swift + SwiftUI**, decided. React Native and
Flutter are out of scope and are named only to record the decision (§13).
Native is chosen for first-class platform integration, the smooth iPad → macOS
path on one SwiftUI source (§9), and direct use of Apple's own
swift-openapi-generator against the committed contract.

## §2 Goals / Non-Goals

### §2.1 Goals

- A universal **iPhone + iPad** app (one SwiftUI source) that signs into and
  switches between **multiple Crowi workspaces**, each an independent host.
- **Full read** of a workspace: browse / open pages, navigate the hierarchy
  (portals / children / backlinks), full-text search (capability-gated),
  view revisions, read comments, see bookmark / like / seen state, view
  profiles and recently-viewed pages.
- **Bounded write**: create a page, quick-edit an existing page's body (with
  `revision_id` optimistic locking and explicit `409` conflict handling),
  post a comment, and toggle engagement (bookmark / like / mark-seen / watch).
- **Per-workspace auth** via OAuth 2.0 Authorization-Code + PKCE (ASWAS +
  custom-scheme `crowi-ios://callback`, trusted `crowi-ios` client, no consent
  screen, §4), Keychain-stored, with transparent `401`→refresh→retry and
  **single-flight** rotation handling. Logout revokes the refresh token
  server-side.
- **Per-workspace data isolation**: each host gets its own typed client
  instance, its own Keychain credentials, and its own SwiftData store file —
  host A's pages / search / cache never appear under host B.
- **Graceful version-skew handling**: detect each host's version + capabilities
  from `/app/info`, gate features that a host lacks, and decode responses
  leniently — warn, never hard-fail, on skew.
- **A macOS-ready architecture**: clean model/view separation and all
  platform-specific UI isolated behind OS-conditional / size-class boundaries,
  so macOS is incremental (§9), not a rewrite.

### §2.2 Non-Goals (v1)

- **Realtime collaborative editing** (`/collab`, Yjs/Hocuspocus). No Swift Yjs
  binding exists and re-implementing the CRDT in Swift is prohibitive; v1 edits
  through the REST `revision_id` path and accepts last-write-wins (§8).
- **Remote push (APNs)**. No server push infrastructure exists; v1 polls REST
  while foregrounded. The future multi-workspace APNs design is sketched as
  explicitly out of scope (§11).
- **Password-login and PAT auth.** v1 auth is OAuth-only (§4): no
  email/password screen in the app (the password, if the host uses one, is
  entered on the host's web login page inside the OAuth webview, never in the
  app) and no pasted PAT. The **device-authorization grant** (RFC 8628, already
  server-implemented) is reserved for a future cross-device "scan to sign in"
  feature, not v1 (§4.5 / §15).
- **Admin operations**. The admin API is not a target; the OAuth session is a
  normal user session scoped to non-admin scopes, and admin screens are not built.
- **A standalone macOS / visionOS build**. macOS is architecturally enabled
  (§9) but shipping it is future work.
- **An offline write-sync / background-mutation engine**. v1 caches reads and
  performs writes online with conflict surfacing; it does not queue offline
  edits for later replay (§7.4).

## §3 Multi-workspace model

Multi-workspace is **foundational**, not deferred. The mental model is taken
directly from the RFC-0012 CLI: its `Profile` (alias + endpoint + tokens +
cached capabilities/version, one per targeted instance) maps one-to-one onto a
**workspace**.

```
App (SwiftUI @main)
 └── WorkspaceStore  (observable; ordered workspace list + activeWorkspace)
      ├── Workspace A  { id, workspaceOrigin, apiBaseURL, account, capabilities, version }
      │     ├── Keychain item   (OAuth access + refresh token)  — service=bundleID, account=A.id
      │     ├── APIClient(serverURL: A.apiBaseURL)              — origin + /api/v2 (see below)
      │     └── ModelContainer  (…/workspaces/<A.id>/crowi.store)  — isolated SwiftData store
      ├── Workspace B  { … }   ← fully independent of A
      └── …
```

- **A workspace = a host + isolated auth + isolated cache.** Its identity is
  the normalized origin URL. Two derived URLs are used throughout and **must not
  be conflated**:
  - **`workspaceOrigin`** = `scheme + host + port` only. This is the **display**
    identity, the subject of the HTTPS check, and the base against which
    **relative URLs (attachment images, avatars, `/files/<id>`) are rebased**
    (§6.1). **HTTPS is required by default**: v1 rejects a cleartext `http`
    origin *before any auth* (§14); `http` is permitted **only** for an explicit
    local/dev host (`localhost`, `127.0.0.1`, `*.local`) behind a documented App
    Transport Security exception.
  - **`apiBaseURL`** = `workspaceOrigin` + `/api/v2`. This is what the generated
    `Client(serverURL:)` is constructed with, and what every OAuth endpoint
    (`/oauth/authorize`, `/oauth/token`) and `/app/info` probe is built on.
    **This distinction is load-bearing**: the committed `openapi.json` carries
    `/api/v2` in its `servers` entry while the operation `path`s are **bare**
    (`/auth/login`, `/pages`, …), so the generated client expects its
    `serverURL` to already include `/api/v2`. Passing **`workspaceOrigin` alone**
    to `Client(serverURL:)` would send every call to the wrong path (e.g.
    `https://host/pages` instead of `https://host/api/v2/pages`) and 404. So:
    rebase relative *content* URLs against `workspaceOrigin`; construct the API
    *client* against `apiBaseURL`.
  - **Keychain credentials** — `kSecClassGenericPassword`,
    `service = bundle identifier`, `account = workspace id`, value = a JSON
    struct `{ accessToken, refreshToken, expiresAt }`, where `expiresAt` is
    **computed by the app** at token receipt as `receipt instant + expires_in`
    (the OAuth token response carries the relative `expires_in`, §4.2; there is
    no server `expiresAt`). Secrets never live in `UserDefaults` and never cross
    a workspace boundary;
  - **one typed client** — `Client(serverURL: apiBaseURL, transport:)` (§5), so
    a request can only ever be sent to its own host;
  - **one SwiftData `ModelContainer`** backed by a per-host store file
    (§7) — physical data/cache isolation, so a stale page from host A can never
    be served under host B.
- **Non-secret index.** An ordered list of `{ id, workspaceOrigin, displayTitle }`
  (no tokens) is persisted outside the Keychain (e.g. a small SwiftData store
  or `UserDefaults`) to drive the Slack-style switcher and remember workspace
  order. Tokens are read from the Keychain lazily when a workspace becomes
  active.
- **Add-workspace flow.**
  1. The user enters a host URL → normalized to `workspaceOrigin`. The app
     **rejects a cleartext `http` origin** (warning the user) unless it is an
     explicit local/dev host (§14); the probe and OAuth flow below run over
     `https` only (against `apiBaseURL = workspaceOrigin + /api/v2`).
  2. The app fetches `GET {apiBaseURL}/app/info` (over HTTPS — step 1) **with the
     §5.2 lenient decoder, not the generated strict response type**. This is
     deliberate and load-bearing: the probe runs *before* the per-workspace
     generated client/transport exists (there is no authenticated client yet —
     the workspace is still being added), and `AppInfoResponseSchema` marks
     `version` / `apiVersion` / `capabilities` as **required**
     (`packages/api-contract/src/schemas/app.ts:39-46`), so a host that omits
     `capabilities` (an older/skewed Crowi) would **hard-fail a strict decode and
     block add-workspace entirely** — the exact failure §5 exists to prevent.
     Decoded leniently, such a host instead **degrades to the static capability
     baseline** (§5.2). If the response leniently parses as a Crowi
     `AppInfoResponse`, the host is a Crowi server; its `title`, `version`,
     `apiVersion`, `capabilities[]`, **and `confidential`** are captured into the
     per-workspace `/app/info` cache that the §6.3 banner and §5.2 capability
     gates read — a cache that is **refreshed on activation / foreground and on a
     10-minute TTL** (§5.2), not frozen at add-time. A non-Crowi host (nothing
     resembling `/app/info` — e.g. no `version`) is rejected with a clear error.
  3. **Minimum-version gate (§4.4).** The captured `version` is checked against
     the floor that ships the trusted `crowi-ios` client. A **too-old** host is
     **refused** with *"this Crowi is too old for the app — upgrade to X.Y+"* and
     is **not added** — there is no password fallback.
  4. The user authenticates via **OAuth Authorization-Code + PKCE in an
     `ASWebAuthenticationSession`** (§4.1): the host's own login page handles
     authentication (password or any RFC-0014 SSO provider), the trusted
     `crowi-ios` client skips consent, and the app exchanges the returned code
     for an access + refresh token pair. On success the workspace is persisted
     (index + Keychain + a fresh `ModelContainer`). There is **no** in-app
     password field or token-paste.
- **Switching** swaps `activeWorkspace`, which swaps the client + the
  `ModelContainer` injected into the SwiftUI environment and re-roots the
  navigation stack keyed on workspace id. Switching is local and instant; no
  network round-trip is required to switch (cached reads render immediately,
  then refresh).
- **Independent sign-out.** Signing out of one workspace **revokes that
  workspace's refresh token server-side** (`POST /oauth/revoke`, §4.2) and clears
  its Keychain item (and its store, per the §7/§14 cache-deletion policy); the
  others remain authenticated and intact — the exact per-profile independence the
  CLI has (RFC-0012 §5). Unlike a stateless JWT, this is a true server-side kill
  switch for that one device/workspace.
- **Version/capability differences are expected and handled** by the §5 lenient
  decoding plus per-workspace capability gating (a host whose
  `/app/info.capabilities` lacks `search` hides the search UI — §5.2).

## §4 Authentication (per workspace) — OAuth 2.0 Authorization Code + PKCE

v1 authenticates each workspace with **one** mechanism: the **OAuth 2.0
Authorization Code flow with PKCE**, run inside an `ASWebAuthenticationSession`
and capturing a **custom-scheme callback (`crowi-ios://callback`)**, against a
**dedicated, server-seeded, first-party `crowi-ios` OAuth client that is marked
`trusted` so the consent screen is skipped**. There is **no password-login
path** and **no PAT** in v1. The credential the app stores is the OAuth
access + refresh token pair — rotating, reuse-detected, DB-backed, scope-bounded,
and individually revocable.

### §4.1 The ASWebAuthenticationSession + custom-scheme Authorization-Code flow

Adding a workspace runs the OAuth Authorization-Code + PKCE flow the CLI uses
(RFC-0012 §4), but with the **iOS-native transport**: an
`ASWebAuthenticationSession` (ASWAS) capturing a **custom-scheme callback**.
This is the standard "sign in with a webview" pattern (the same shape as a
Google-login webview) and is **not** the CLI's mechanism — the CLI runs a real
local HTTP server and captures an `http://127.0.0.1` loopback callback, which is
**impossible inside ASWAS**: ASWAS only delivers a result by matching a
`callbackURLScheme` (a custom scheme) — or, on iOS 17.4+, an `https`
universal-link — and never an http/loopback URL. (The redirect transport itself
is a Phase-0 GO/NO-GO gate, §4.4.)

0. **Discover endpoints (RFC 8414).** Before anything, the app fetches
   `GET {workspaceOrigin}/.well-known/oauth-authorization-server` and reads
   `authorization_endpoint`, `token_endpoint`, and
   `device_authorization_endpoint` from the response
   (`packages/api/src/hono/handlers/oauth.ts:385-404`). These **may be on
   different origins** — the `authorization_endpoint` is a **web-origin** page on
   `CLIENT_URL` (`${issuer}/oauth/authorize`, **no** `/api/v2`) while the token
   endpoint is under `/api/v2` (`${issuer}/api/v2/oauth/token`); they are
   same-origin only "in the default deployment" (`oauth.ts:387-399`). The app
   therefore **MUST** resolve these from discovery and **MUST NOT** hardcode
   `apiBaseURL + /oauth/...` — exactly as the CLI does
   (`packages/cli/src/lib/oauth.ts:227-236`).
1. **Open the host's `authorization_endpoint` web page in ASWAS.** The app opens
   the discovered `authorization_endpoint` (the **web app's** HTML
   `/oauth/authorize` page, *not* the `/api/v2` JSON endpoint) inside an
   `ASWebAuthenticationSession`, with `callbackURLScheme = "crowi-ios"`, passing
   `client_id=crowi-ios`, the PKCE `S256` `code_challenge`, the requested
   `scope`, `state`, and `redirect_uri = crowi-ios://callback`. ASWAS is an
   ephemeral, cookie-isolated browser session. The user authenticates on **the
   host's own login page**, so **whatever that host supports works**: email +
   password today, or a future SSO / auth-provider plugin (RFC-0014) tomorrow.
   **The app never sees or handles the raw password** — it is entered into the
   host web page, not the app.
2. **Skip consent (trusted client) — via web session + auto-submit.** The login
   in step 1 establishes the **web session cookie** on the host. The Next.js
   `/oauth/authorize` page is a **client component** that `POST`s
   `apiClientV2.oauth.authorize.$post` (the web-session-only JSON authorize
   endpoint) and then navigates to the returned `redirectUri`
   (`packages/web/src/app/(auth)/oauth/authorize/page.tsx`). For the **trusted**
   `crowi-ios` client it **auto-submits without rendering `ConsentCard`** (§4.4),
   so the server issues the code and the page redirects to
   `crowi-ios://callback?code=…&state=…`. **ASWAS captures that custom-scheme
   callback** and hands it to the app. (Note this depends on *both* the API
   authorize branch *and* the web page's auto-submit shipping — §4.4.)
3. **Exchange code → tokens (PKCE proof).** The app `POST`s the discovered
   `token_endpoint` with the `code` + the PKCE `code_verifier`, receiving an
   **access token + refresh token** pair (opaque `crowi_rt_…` refresh secret)
   and an `expires_in`. The pair is stored in that workspace's Keychain item
   (§4.3). `state` is verified to match what the app sent.
4. **Authenticated calls / refresh.** Every request carries
   `Authorization: Bearer <accessToken>` (§5.1). On a `401`, the app exchanges
   the refresh token at the `token_endpoint` (`grant_type=refresh_token`) for a
   fresh pair and retries once. **Refresh tokens rotate and are reuse-detected**
   (§4.2), which makes the §16 single-flight requirement mandatory, not optional.

The app requests its scopes **up front** at authorize time — e.g.
`pages:read pages:write comments:write bookmarks:write notifications:read`
(the granted set is recorded on the auth code, `packages/api/src/hono/handlers/oauth.ts:172,206`)
— so the access token is already scoped to exactly what the app does and **v1
never encounters `403 INSUFFICIENT_SCOPE`** on a write.

The **single registered redirect URI** for the `crowi-ios` client is
`crowi-ios://callback` (§4.4) — there is no loopback host/port to register or
match. The app claims that scheme via its `Info.plist` `CFBundleURLTypes`; only
the installed app can receive it (the §14 interception reasoning).

(Legacy framing removed: earlier drafts of this RFC proposed JWT password-login
and weighed a PAT-paste fallback; both are dropped — see §13 for why OAuth is
chosen instead.)

### §4.2 The credential is the OAuth token pair — revocable, scoped, rotating

Unlike a stateless password-login JWT, the OAuth credential v1 stores is a
**real, server-managed grant**:

- **Individually revocable, per workspace / per device.** Each workspace holds
  its own refresh token. Signing out of one workspace (or a server-side
  "revoke this device") revokes **that** refresh token alone
  (`packages/api/src/models/oauth-refresh-token.ts:7-26,120-146`) — the other
  workspaces, and the user's web/other sessions, are untouched. This is a real
  server-side kill switch: a lost phone can be de-authorized for one host
  without a host-wide logout of everyone.
- **Rotating + reuse-detected.** Every refresh **rotates** the token (the old
  one is revoked, a fresh one issued) and a replay of an already-rotated token
  triggers `revokeChain`, killing the whole chain
  (`oauth-refresh-token.ts:7-26`). This is why §16's **single-flight refresh is
  mandatory, not optional**: two concurrent refreshes would present the same
  token twice and trip reuse-detection, revoking the workspace.
- **Scope-bounded.** The token carries exactly the scopes the app requested at
  authorize time (`oauth.ts:172,206`); it is **not** an all-scopes credential.
  Because the app requests its write scopes up front, it never hits
  `403 INSUFFICIENT_SCOPE` — the scope is correct by construction, not narrowed
  after the fact.
- **`expiresIn` → computed `expiresAt`.** The token response carries
  `expires_in` (seconds-until-expiry of the access token), not an absolute
  timestamp. The app derives `expiresAt = (receipt instant) + expires_in` and
  stores `{ accessToken, refreshToken, expiresAt }` in the workspace's Keychain
  item (the computed `expiresAt`, not a server field); that value drives the
  §5.1 proactive refresh.

### §4.3 Keychain isolation

Credentials live only in the Keychain, one item per workspace
(`service = bundle id`, `account = workspace id`, value =
`{ accessToken, refreshToken, expiresAt }`). The active workspace's token is the
only one ever attached to a request, and the per-workspace client (§5) makes it
structurally impossible to send workspace A's token to host B. Sign-out deletes
exactly one Keychain item **and** revokes that workspace's refresh token
server-side (§4.2).

### §4.4 The trusted `crowi-ios` client + the server companion changes

The choice rests on a **dedicated, server-seeded, first-party, *trusted* OAuth
client** that lets the app skip the consent screen while still authenticating
the user on the host's own login page. This needs a **coordinated set of
server-side changes that ship together in the minimum Crowi version** — bounded
and well-scoped, but **more than a single flag** (it spans the API *and* the web
app), so there is **no per-host operator action** once a host is on the floor
release.

**Why a dedicated trusted client (not the CLI's client).** The CLI's seeded
`crowi-cli` client is `firstParty: true` but `trusted: false`
(`packages/api/src/util/oauth-client-seed.ts:36-39`), so authorizing through it
shows the **consent screen on every login** (there is no stored, remembered
grant) and presents the *CLI's* identity. A native app wants its **own**
identity and a **no-consent** first-party experience, which is what a `trusted`
client provides.

**The companion changes (the server-side delta RFC-0016 carries):**

1. **Seed a `crowi-ios` OAuth client** with `trusted: true`, `firstParty: true`,
   `type: 'public'` (PKCE, no secret), and the **custom-scheme redirect URI
   `crowi-ios://callback`** as its single registered `redirectUris` entry —
   added alongside `crowi-cli` in `packages/api/src/util/oauth-client-seed.ts`
   (which today seeds only `crowi-cli`, `:23-44`). Idempotent `$setOnInsert`,
   same as the existing seed.
2. **Relax the redirect-URI validator to allow a custom scheme for trusted
   first-party clients.** Today the validator **rejects every non-`http(s)`
   scheme** (`packages/api/src/util/oauth-redirect-uri.ts:34-36`), so
   `crowi-ios://callback` would be refused. The change permits an exact-match
   custom-scheme redirect **for a `trusted` first-party client only** (the public
   web still gets http(s)-only validation), so the app's registered
   `crowi-ios://callback` is accepted while open-redirect protection is preserved
   for everyone else.
3. **Wire the reserved-but-inert `trusted` flag in BOTH the API and the web
   app.** The field exists on the model but is explicitly dead:
   `packages/api/src/models/oauth-client.ts:31-32` comments *"Reserved: even a
   trusted client still shows the consent screen in v1"*, and the authorize
   handler reads the client but **never branches on `trusted`**
   (`packages/api/src/hono/handlers/oauth.ts:166-222`). Wiring =
   - **(API)** the authorize handler, for a `trusted` client with an
     otherwise-valid request, **issues the code without requiring a separate
     consent confirmation**; and
   - **(WEB)** the Next.js `/oauth/authorize` page
     (`packages/web/src/app/(auth)/oauth/authorize/page.tsx`, a client component
     that today always renders `ConsentCard` and waits for a click) **auto-submits
     `apiClientV2.oauth.authorize.$post` and navigates to `redirectUri` without
     rendering `ConsentCard`** for a trusted client.

This is therefore an **API + WEB** change (plus the seed + validator relax), not
one flag. Because it all ships **in the minimum Crowi version**, every host the
app can add already has the seeded trusted client, the custom-scheme redirect,
and the auto-submit path; the app performs **no** per-host setup.

**Phase-0 GO/NO-GO — the redirect transport.** The chosen default is **ASWAS +
the custom scheme `crowi-ios://callback`** (the standard iOS pattern). The
Phase-0 gate confirms it end-to-end (ASWAS `callbackURLScheme` capture + the
validator relax + the auto-submit). **Alternates**, if custom-scheme proves
unworkable: (a) **ASWAS + an `https` universal link** (iOS 17.4+ ASWAS supports
an https `callbackURLScheme`; needs an **app-owned associated domain**, which the
app cannot host on an arbitrary Crowi origin, so it is a poor fit for the
connect-any-host model); (b) a **local listener without ASWAS** (the CLI's
loopback approach) — workable but **loses ASWAS's ephemeral cookie isolation**
and has a **weaker App-Review posture** for an arbitrary-host client. Custom
scheme is pinned as the default; the alternates are recorded fallbacks.

**Minimum Crowi version — keyed on the WEB app, not just the API (and why there
is no fallback).** The app **requires a host whose Crowi version ships all of
the companion changes — crucially including the *web* app's auto-submit**, not
only the API authorize branch: a host whose **web** `/oauth/authorize` page
predates the auto-submit would render `ConsentCard` inside ASWAS and **break the
no-consent flow even if the API branch is present**. At add-workspace, the
lenient-decoded `/app/info` probe (§3 / §5.2) does version detection; a
**too-old** host is shown *"this Crowi is too old for the app — upgrade to
X.Y+"* and is **not added — there is no password fallback.** Hosts at or above
the floor are all supported, with cross-version skew handled by capability
detection + lenient decode (§5.2). The app targets `/api/v2`, so only Crowi
**2.0+** hosts are reachable at all; the floor is the 2.0.x release that ships
the `crowi-ios` client + validator relax + API and web auto-approve. (The exact
version string is filled in when that release is cut — OQ-6 in §16.)

### §4.5 SSO works for free; the device grant is a reserved future feature

- **SSO / auth-provider plugins need no app change.** Because authentication
  happens on the host's own `/oauth/authorize` login page inside the webview,
  any inbound auth-provider the host enables under **RFC-0014** (SSO, social,
  enterprise IdP) is exercised by the user *in that page* — the app just
  receives the resulting authorization code. There is no separate "SSO mode" to
  build in v1: the OAuth ASWAS flow already covers password **and** every future
  host-side login method. RFC-0014 is therefore a dependency only of the *host's*
  login page, not of this app.
- **The Device Authorization Grant (RFC 8628) is reserved for a future
  cross-device sign-in.** The server already **fully implements** the device
  grant (`packages/api/src/hono/handlers/oauth.ts:409-490`): a logged-in desktop
  could show a QR code that the phone scans to sign in ("scan to sign in"), with
  **no protocol change** — only QR rendering + the in-app flow wiring are
  missing. This is noted as a **future feature** (§15 / §16), not v1; v1 ships
  only the ASWAS Authorization-Code flow above.

## §5 API consumption — hybrid generated client, lenient decoding

### §5.1 One generated client per workspace, from the in-tree contract

The Swift networking layer is generated from the committed
`packages/api-contract/openapi.json` (OpenAPI 3.1.0) with
[swift-openapi-generator](https://github.com/apple/swift-openapi-generator)
(an Apple SwiftPM build plugin). The generated client is a **build-time
artifact**: it is produced by the SwiftPM build plugin from `openapi.json` on
every build and is **NOT committed** to the repo (matching the generator's own
model — generate-on-build, do not vendor). Its generated `Client` takes a
`serverURL` constructor argument, so the app instantiates **one client per
workspace**, each pinned to that workspace's **`apiBaseURL`**
(`workspaceOrigin + /api/v2`, §3 — *not* the bare origin; the spec's `servers`
entry already carries `/api/v2` while operation paths are bare, so passing the
origin alone would 404 every call) — the direct analogue of the CLI's
`createClient(baseUrl)` per-profile pattern (RFC-0012 §3) and of the web RPC
client. The generator's `ClientTransport` (an `URLSessionTransport`) is the
**auth-injection seam**: a per-workspace transport wrapper adds
`Authorization: Bearer <accessToken>` and runs the §4 `401`→refresh→retry loop
(an **OAuth** `grant_type=refresh_token` exchange), the native counterpart of
the CLI's `authedFetch`. The same wrapper **refreshes proactively**: it reads
the stored `expiresAt` (computed from `expires_in`, §4.2) and re-mints shortly
before expiry rather than waiting for a `401`. Because OAuth refresh tokens
**rotate and are reuse-detected** (§4.2), the wrapper **must single-flight**
refreshes (§16 — promoted to a Phase-1 requirement): concurrent refreshes would
present the same token twice and trip `revokeChain`. The reactive `401`→refresh
remains the backstop for clock skew and server-side expiry/revocation. **The
OAuth `token_endpoint` the refresh hits is the one resolved from RFC 8414
discovery (§4.1, step 0), not assumed to equal `apiBaseURL`** — discovery may
place `authorization_endpoint` (web origin) and `token_endpoint` (`/api/v2`) on
different origins, so the refresh transport uses the discovered `token_endpoint`
even though the generated REST client is pinned to `apiBaseURL`.

Generating from the **in-tree** `openapi.json` (not a pinned copy) is the whole
point of the §10 monorepo layout: a contract change and the Swift client move
in the same change set, with `pnpm check:openapi` already guaranteeing the
committed spec matches the live API. The generated surface is large (~92 paths)
but the generator splits output by OpenAPI tag, keeping it tractable.

**Phase-1 GO/NO-GO — does swift-openapi-generator 3.1 generate cleanly from the
real spec?** `openapi.json` is OpenAPI **3.1.0** and exercises features the
generator has historically been uneven on: `anyOf` (≈158 occurrences), `oneOf`
(≈4, incl. `TokenRequest`), **type arrays** (≈462) and **`null` types** (≈86,
e.g. `type: [string, null]`), and unions like `Page.revision` (`string |
Revision`, §8) and date/string/null shapes. Whether generation **succeeds** on
this exact document is a gate to clear **early in Phase 1**, not an assumption.
Recorded fallbacks if it does not (OQ in §16): down-convert a generation copy to
OpenAPI 3.0, generate from a **thinned** client spec (only the operations the
app calls), limit generation to a subset of operations, or hand-write the client
against the contract. This is independent of the renderer GO/NO-GO below.

**Where strict decoding is bypassed (lenient-decode spike).** The generator's
*response* types are strict `Codable` (it rejects type mismatches / missing
required keys), which collides with the §5.2 multi-host lenient-decode policy.
The app therefore does **not** decode responses through the generated strict
types unchanged; the value of generation is largely **request/path-centric**
(typed inputs + correct paths). A Phase-1 spike must pin **where** the tolerant
decoder lives (§5.2 / §16, OQ): a custom decoder layer over the generated
transport, hand-written tolerant response models for the screens read, or
relaxing the generated response types to optionals. Verify this seam exists in
the generator's output before committing to it.

**v1 GO/NO-GO — the renderer's image path must be controllable enough to carry
the §6.1 auth + redirect guards.** Every embedded image is auth-gated with **no
public/CDN fallback**: `AttachmentSchema.url` is the relative
`/api/v2/attachments/<id>`, served only by the authenticated, page-grant-checked
byte stream (`packages/api/src/hono/handlers/attachment-stream.ts:173-228`)
(avatars take the by-key path, §6.1). swift-markdown-ui / MarkdownUI renders
`![](url)` through its **own** image-fetch pipeline, so v1 image rendering
**hinges** on routing that pipeline through the per-workspace Bearer-injecting
loader of §6.1 — which is not merely "set a base URL" but must carry, **per
request**, the same-origin Bearer decision *and* the origin-changing-redirect
strip (the §14 token-exfiltration defense). The GO/NO-GO (OQ-10) is therefore
broader than "does `.markdownImageProvider` accept a loader closure"; it is:
1. **Can the provider closure carry per-request async auth + redirect-strip
   state?** A closure that only maps a `URL → Image` with no hook for the
   underlying `URLSession`'s redirect delegate cannot install the §6.1
   redirect-strip guard, so it is **not sufficient** on its own.
2. **Can the renderer be bypassed for images entirely — does it surface image
   *nodes*** so the app can render them with its own fully-controlled
   `URLSession`-backed view? This is the fallback, **and it is itself
   unverified**: if the library exposes *only* the provider closure (no
   image-node access), then **both** the primary and the fallback are at risk
   and §6.1's same-origin-Bearer + redirect-strip guards may be uninstallable.
If neither path can carry those guards, the image subsystem needs a different
approach (e.g. pre-resolving image URLs through the loader and substituting
data: only after raster-decode in-app, or a different Markdown renderer). This
is a real feasibility gate to settle **before** committing the renderer in
Phase 1, not an afterthought of the §12 "base-URL-rebasing loader" row.

**Do not lock the renderer to MarkdownUI — spike both candidates.**
swift-markdown-ui (MarkdownUI) is in **maintenance mode**; active development has
moved to the **Textual** fork. The Phase-1 renderer spike must evaluate **both**
against the image-path criteria above (provider seam + redirect-hook + image-node
bypass) *and* native-extension coverage (§6), and the renderer choice is **decided
by that spike's outcome**, not pre-committed here. OQ-10 (§16) tracks this as a
two-library go/no-go.

### §5.2 Responses are decoded leniently (multi-host version skew)

A single app build must talk to **N hosts of differing Crowi versions** without
hard-failing on drift — the same property that lets `@crowi/cli` (RFC-0012
§3.3–§3.4) target many instances. Therefore:

- **Requests** use the generated request types / paths — the v2 contract floor
  the app is built against, validating the app's own input before sending.
- **Responses** are decoded **leniently**: read only the fields a screen needs,
  **ignore unknown/extra fields** (a newer host), and tolerate **missing
  optional** ones (an older host). The app does not impose a strict,
  closed-world decoder on responses; on a field it cannot map it **warns and
  degrades** rather than throwing. (Swift's `Codable` rejects unknown keys
  benignly but is strict about *missing* required keys and type mismatches, so
  response models lean on optionals + tolerant custom decoding at the points
  where hosts are known to differ — this is a deliberate divergence from the
  generated strict response types, used only on the response side.)
- **`/api/v2` is the compatibility boundary.** The server commits to additive,
  backward-compatible change within v2; a breaking change becomes `/api/v3`.
  The app targets v2 and degrades within it.
- **Per-workspace capability/version detection — on a refreshed cache.**
  `GET /api/v2/app/info` yields `{ version, apiVersion, capabilities[],
  confidential }`. The app caches this **per workspace**, but the cache is
  **not** a one-shot snapshot taken at add-time — both `confidential` and the
  runtime capabilities can change on the host *after* a workspace is added:
  `confidential` is operator-set at runtime
  (`packages/api/src/hono/handlers/app.ts:52-56`) and `search` is appended only
  while a search driver is active (`…/app.ts:33-41`), so a workspace can become
  confidential, or gain/lose `search`, at any time. A frozen cache would leave
  the §6.3 confidential banner and the capability gates **stale indefinitely**,
  silently defeating the compliance control. The app therefore **re-fetches
  `/app/info` on workspace activation and on app foreground, and otherwise on a
  10-minute TTL** (matching RFC-0012's per-profile `/app/info` cache cadence).
  Both the §6.3 confidential banner and the capability gating below read this
  **refreshed** cache. The app uses it to:
  - **gate features** a host lacks — e.g. `search` is a *dynamically* advertised
    capability, appended only when a search driver is active
    (`packages/api/src/hono/handlers/app.ts:33-41`); a host without it returns
    `503 { feature: 'search' }` from `GET /search`
    (`packages/api/src/hono/handlers/search.ts:57,83`), so the app **hides the
    search UI** when the refreshed `capabilities` lacks `search` rather than
    letting the user hit a 503 (and re-shows it if a later refresh reports
    `search` is back);
  - **warn on skew — keyed on `version`, not `apiVersion`.** `apiVersion` is the
    constant string `'v2'` (`API_SURFACE_VERSION = 'v2'`,
    `app-capabilities.ts:48`) and by the §5.2 rule above it only ever flips to
    `'v3'` on a breaking boundary — it is **binary equal/not-equal**, so it can
    gate the hard "this app speaks v2, this host speaks v3" case but carries no
    notion of "how far". Graduated skew warnings therefore key on the **`version`
    semver field** of `/app/info` (`AppInfoResponseSchema.version` — the running
    `@crowi/api` package version, `schemas/app.ts:42`): the app compares the
    host's `version` against the version it was built against and raises a
    **non-blocking** notice when the gap exceeds a product-chosen threshold
    (the threshold itself is part of OQ-6 — the upper-skew-warning policy). A
    mismatched `apiVersion` is the separate,
    coarser signal (potential incompatibility); a distant `version` is the
    graduated "you may be missing newer behaviour / your app may be stale"
    nudge. Neither is ever a refusal.

The static capability baseline (`STATIC_CAPABILITIES`,
`packages/api-contract/src/schemas/app-capabilities.ts:28-41`:
`oauth*, pat, pages, comments, bookmarks, attachments, notifications`) is
always present; `search` / `collab` / `collab:redis` are runtime-detected. An
old host that omits `capabilities` entirely degrades to the static baseline.
**This degrade-to-baseline path only works under the lenient decoder**:
`AppInfoResponseSchema.capabilities` is a **required** field
(`packages/api/.../schemas/app.ts:44`, no `.optional()`), so the *generated
strict* response type would throw on a host that omits it rather than fall back.
Both the add-time `/app/info` probe (§3 add-flow step 2 — which runs before any
generated client exists) and every later refresh therefore decode `/app/info`
leniently and substitute the static baseline when `capabilities` is absent.

## §6 Rendering — native Markdown from the raw body

Pages render **natively** from the raw `revision.body` Markdown string
(`RevisionSchema.body`, `packages/api-contract/src/schemas/page.ts:89`) using a
cross-platform SwiftUI Markdown renderer
([swift-markdown-ui](https://github.com/gonzalezreal/swift-markdown-ui) /
Textual). The server-produced `renderedAst` is **not** consumed:

- It is typed `unknown` in the contract
  (`RevisionSchema.renderedAst`, `…/page.ts:100`) and is a web-coupled mdast
  JSON the web app re-walks client-side; its shape can change at renderer major
  bumps (it carries a `rendererVersion`, `…/page.ts:105`).
- Consuming it would couple the app to **each host's renderer version** — the
  exact multi-host skew §5 exists to avoid — and its Shiki code-block styling
  is expressed as web CSS variables that mean nothing outside the web app's CSS.

Rendering the raw Markdown is version-agnostic and avoids the web renderer's
inline-HTML-`<script>` surface — but "text, not arbitrary HTML" is **not** by
itself a security guarantee: the body is still untrusted and unsanitized
server-side, so its **link/image URLs** must be scheme-allowlisted (§6.2) and
its image fetches must be same-origin-Bearer-gated (§6.1) before the renderer
acts on them. The trade-off is that **Crowi-specific Markdown extensions**
(wikilinks `[[…]]`, `@mentions`, footnotes, PlantUML, etc.) are a **native
rendering gap** the app closes incrementally as native handlers, rather than a
reason to adopt a `WKWebView` renderer (which would re-introduce per-host
renderer coupling and break native scrolling/selection and the per-workspace
Bearer image loading of §6.1). For drafts/previews, `POST /pages/preview`
remains available if a server-rendered preview is ever wanted.

### §6.1 Attachments require a per-workspace Bearer image loader

Embedded images resolve to **auth-gated, relative** URLs. `AttachmentSchema.url`
is the relative path `/api/v2/attachments/<id>`
(`packages/api-contract/src/schemas/attachment.ts:10,32`), and that endpoint is
Bearer-gated **and** page-grant-checked, streaming raw bytes only to an
authorized caller (`packages/api/src/hono/handlers/attachment-stream.ts:173-228`:
grant check at `:198`, byte stream at `:221-228`). **There is no public/CDN
URL** — an image cannot be fetched anonymously.

So the app's image loader must, for every embedded image:

1. **rebase** the relative URL against the *active workspace's* base URL, and
2. inject `Authorization: Bearer <that workspace's access token>` **only when
   the resolved URL is same-origin with that workspace's base URL** (see the
   rule below).

This is a per-workspace URLSession / request interceptor (the native analogue
of the CLI's `authedFetch`). Switching workspace re-keys the loader so images
are always fetched with the correct host + token. The browser-only
`crowi.accessToken` cookie fallback is irrelevant to native.

**There are *two* auth-gated image URL shapes, and the loader must cover both.**
Besides embedded attachments at `/api/v2/attachments/<id>`, **user avatars**
come via `UserSchema.image` (`packages/api-contract/src/schemas/user.ts:41`),
served by `GET /api/v2/attachments/by-key/<key>` — which, despite its
"public-keyed delivery" file comment, is **Bearer-gated + prefix-restricted**
(`createJwtAuth` on `/attachments/by-key/*`,
`packages/api/src/hono/handlers/attachment-stream.ts:120`; only a `user/`-prefix
key is allowed, `:44-45,:141-143`). **Its access model differs from the embedded
path: the by-key handler does *not* page-grant-check** — it has no
`loadGrantedPage` call (`:128-161`), so *any* workspace-authenticated user may
fetch *any* `user/`-prefixed key. Only the numeric-id embedded handler enforces
the page grant (`loadGrantedPage` at `:198`). This asymmetry is fine for avatars
(profile images are not per-page-secret), but the loader must not assume by-key
fetches are grant-scoped. Either way the same per-workspace
rebase + same-origin-Bearer loader MUST handle **both**
`/api/v2/attachments/<id>` (embedded images, grant-checked) **and**
`/api/v2/attachments/by-key/<key>` (avatars, Bearer + prefix only); a loader that
special-cases only the numeric-id shape will silently fail to render every
avatar.

Because there is no anonymous image URL, **v1 image rendering depends on routing
the renderer's own image fetches through this loader** — including the
same-origin-Bearer rule and the origin-changing-redirect strip below. Whether
swift-markdown-ui / MarkdownUI's image path can carry *those* guards (not just a
base URL) — and, failing that, whether the renderer exposes image **nodes** so
the app can fetch them with its own fully-controlled `URLSession` — is the
explicit v1 GO/NO-GO of §5.1 (OQ-10). The fallback (custom image view) is itself
unverified: if the library offers only a provider closure with no redirect-hook
and no node access, both the primary and the fallback are at risk and these
guards may be uninstallable.

**Hard rule — the Bearer is same-origin-only (token-exfiltration guard).** Page
bodies are **author-controlled Markdown** and the server does **not** sanitize
them — the web renderer runs with `allowDangerousHtml: true` and **no
`rehype-sanitize`** (`packages/web/src/components/editor/render-mdast.ts:166`).
A body may therefore contain an **absolute external** image URL, e.g.
`![](https://attacker.example/x.png)`. If the loader attached the workspace
access token to *that*, a malicious page would silently **exfiltrate the
workspace's Bearer to an attacker host** on first render. The loader MUST
therefore:

- attach `Authorization: Bearer …` **only** when the (post-rebase) request
  origin **exactly equals** the active workspace's base-URL origin
  (scheme + host + port);
- send **no** Authorization header for any **cross-origin** absolute URL —
  load it as an anonymous request (or refuse it under §6.2's scheme allowlist);
- **on a redirect, strip the Authorization header only when the origin
  *changes*; PRESERVE (re-attach) it on a *same-origin* redirect.** The decision
  is per-hop and origin-keyed, implemented via the URLSession delegate's
  `willPerformHTTPRedirection`: drop the header when the redirect target origin
  differs (off-origin exfiltration guard), keep it when the target is the same
  workspace origin. This is not hypothetical — Crowi exposes a **same-origin
  legacy compat redirect** the loader must follow: `GET /files/<id>` at the
  **server root** (outside `/api/v2`) `302`s to `/api/v2/attachments/<id>` with
  **no auth on the redirect itself** (`attachment-stream.ts:250-252`, comment
  `:244-249` — authorization is deferred to the redirect target, which *is*
  Bearer-gated). Un-migrated page bodies still contain bare `/files/<id>`
  references (the `files-url-to-attachments` body migration cannot rewrite them
  all — misses, un-migratable bodies, and bodies the web app forwards via its
  `/files/:id` rewrite — which is exactly why the runtime redirect exists). Since
  that `/files/<id>` → `/api/v2/attachments/<id>` hop is **same-origin**, a
  blanket "strip on any redirect" rule would make every such image silently
  `401`; the origin-change-only rule keeps the Bearer on the target and the image
  loads.

Relative attachment URLs (including bare `/files/<id>`) always rebase to the
workspace origin and so always keep the Bearer across same-origin hops; only
absolute/redirected **off-origin** fetches are stripped. This is what makes the
§14 "cannot leak cross-grant bytes" claim hold without breaking the legacy
same-origin compat redirect.

**Hard rule — attachment bytes are decoded as raster images only, never in a
web/SVG-DOM context.** The attachment stream returns the stored
`Content-Type: attachment.fileFormat` with `Content-Disposition: inline`
(`packages/api/src/hono/handlers/attachment-stream.ts:224-225`), and **SVG is a
recognized upload type** (`svg: 'image/svg+xml'`, `:53`) with **no server-side
sanitization at the stream layer** — an author can upload an SVG containing
`<script>`. v1 is safe because it never decodes attachment bytes in a web or
SVG-DOM context: the image loader hands the fetched bytes to a **raster image
decoder** (`UIImage`/`Image`) only, so an `<svg><script>` payload is at worst an
un-renderable or statically-rasterized image, never executed. This is a
threat-model invariant, not an incidental property: **any future "open
attachment" / Quick Look / share / in-app web-preview path MUST preserve it** —
attachment bytes are never routed to `WKWebView` or any SVG-DOM renderer. It sits
alongside the §6.2 link/image **scheme** allowlist as the second untrusted-bytes
defense.

**A `200` is not necessarily the real image — the loader/cache must handle a
success / placeholder / error trichotomy.** `GET /attachments/<id>` does **not**
return only real-bytes-or-`401`/`403`. On a **missing `Attachment` record** or a
**missing backing file** (local `ENOENT` / S3 `NoSuchKey`) it returns a generic
**`file-not-found.png` placeholder with `Content-Type: image/png` and HTTP
`200`** (`attachment-stream.ts:192-195` and `:214-216` →
`buildPlaceholderResponse` `:107-113`), deliberately `200`-not-`404` so an
embedded `<img>` degrades gracefully. On a **genuine driver error** it returns
**`500 UPLOAD_FAILED`** (`:188-189`, `:217-218`). So the loader/cache MUST:
- **not treat a `200` as a permanently-resolved attachment** — a placeholder PNG
  is a *transient* "not available right now" state (the real file may appear on a
  later fetch), so it must **not be cached forever** as if it were the image; at
  most cache it briefly / re-fetch on the next view. (Heuristics: the
  `file-not-found.png` is a known fixed asset; a `200 image/png` for an id whose
  page metadata implies a different format is a placeholder tell.)
- **handle `500` distinctly from a placeholder and from `404`** — a `500` is a
  retryable server/driver fault (show a retry affordance), not a "permanently
  gone" result.
The raster-only decode safety (above) still holds for every case — the
placeholder PNG is itself just raster bytes.

### §6.2 Rendered links and images are restricted to an http(s) + workspace-relative scheme allowlist

Because the body is **untrusted and unsanitized server-side** (no
`rehype-sanitize`, render-mdast.ts:166), every `[text](url)` link and `![](url)`
image URL handed to the native renderer is **attacker-influenceable**.
swift-markdown-ui turns `[text](url)` into a tappable `Link`/`UIApplication.open`
target and `![](url)` into an `AsyncImage` fetch, so a body can carry
`[x](javascript:…)`, `[x](file:…)`, `[x](data:…)`, or **any** custom-scheme deep
link and have the renderer *act* on it.
Rendering "native Markdown, not arbitrary HTML" (§6/§14) defeats inline-`<script>`
execution but does **nothing** about a malicious URL **scheme** in an otherwise
valid Markdown link/image. v1 therefore **MUST** apply a strict scheme
allowlist before anything is made tappable or fetched:

- **Allow** only `http`, `https`, and workspace-relative URLs (which rebase to
  the workspace origin, §6.1). Everything else — `javascript:`, `file:`,
  `data:`, `tel:`/`mailto:` (unless deliberately opted in), and **all** custom
  schemes — is **rejected/inerted**: rendered as non-tappable plain text (links)
  or a broken-image placeholder (images), never passed to `UIApplication.open`
  / `Link` / `AsyncImage`.
- The allowlist inerts **every** custom scheme unconditionally — **including the
  app's own `crowi-ios://` OAuth-callback scheme** (§4.1). v1 *does* register
  `crowi-ios://` (for the ASWAS auth callback), so this guard is load-bearing: a
  wiki body containing `[x](crowi-ios://callback?code=…)` must **never** be
  tappable, so the body cannot drive or forge the app's auth-callback handler.
  The allowlist inerts it (and any future custom scheme) by rule, regardless of
  name. Note the auth callback is delivered to the app **only** through ASWAS's
  `callbackURLScheme` capture as the result of a session the app itself started —
  not via a tapped link — so an inerted body link has no path to it anyway; the
  allowlist is the belt-and-suspenders.

### §6.3 The `confidential` notice is rendered as an always-on per-workspace banner

`/app/info` returns an optional operator-set `confidential` string
(`AppInfoResponseSchema.confidential`, `schemas/app.ts:41`; built from
`app:confidential` at `packages/api/src/hono/handlers/app.ts:52-56`). When
present, the **web shell renders it as an always-on header banner specifically
so the notice appears on screenshots / printouts** — an explicit corporate-IT
compliance control (schema comment, `app.ts:13-15`). A native client that reads
a confidential workspace but omits the banner would **defeat that control**, so
v1 **honors it**: when a workspace's cached `/app/info.confidential` is
non-null, the app renders it as a **persistent, non-dismissible in-app banner on
every page view of that workspace** (and on the workspace's chrome generally).
The banner is per workspace and reads the **refreshed** `/app/info` cache
(§5.2): because `confidential` is operator-set at runtime
(`packages/api/src/hono/handlers/app.ts:52-56`), the cache is **not** frozen at
add-time — it is re-fetched on workspace activation and app foreground and on a
10-minute TTL, so a workspace that *becomes* confidential after being added
shows the banner within one refresh cycle rather than staying stale
indefinitely.

**Honest limit — this is an in-app banner, not the web control's
screenshot/print guarantee.** A web header sits over the printed HTML, so it
rides every browser screenshot and PDF print. A SwiftUI in-app banner has **no
equivalent platform guarantee**: it does *not* reliably appear on an OS
screenshot of an arbitrary scroll position, nor on a system share-sheet / Quick
Look / PDF export of the content, the way the web header does. v1 must **not
claim parity it cannot deliver**. To approach the web control's intent on Apple
platforms, the realistic enforcement is twofold and both halves are in v1's
power: (a) pin the banner as a **non-scrolling overlay always rendered on top**
of every screen of a confidential workspace (so any in-app screenshot captures
it wherever the user has scrolled), and (b) for confidential workspaces
**suppress system content-export** — disable copy/share/Quick Look of page
content and mark sensitive views to be **excluded from screenshots/recordings**
(e.g. an `isSecure`-style overlay), so the content cannot trivially leave the
app without the notice. **Open question (OQ-11): how far to take export
suppression** — from "banner overlay only" (minimum) up to fully blocking
share/Quick Look/copy and screenshot-excluding content for confidential
workspaces — is a product/compliance decision, not an architectural one; the
banner-overlay floor ships in v1 and the export-suppression depth is settled with
the compliance owner.

## §7 Persistence — SwiftData, per-workspace container

### §7.1 Per-workspace `ModelContainer`

Persistence uses **SwiftData** with a **distinct `ModelContainer` per
workspace**, each backed by its own store file
(e.g. `Application Support/workspaces/<workspace-id>/crowi.store`). This gives
**physical** cache isolation between hosts: there is no shared table a query
could accidentally cross, so a page, search result, or comment cached for host
A can never surface under host B. The active workspace's container is injected
into the SwiftUI environment and swapped on workspace switch (§3).

The platform floor is **iOS 17 / macOS 14 (Sonoma)**, SwiftData's minimum.
This is an accepted constraint; it is revisited only if large-dataset
performance forces Core Data. (Because iOS 17 excludes older devices, the
release checklist includes an **iOS-version-share check** for enterprise reach
— §16.)

### §7.2 What is cached — and how it is protected at rest

Read models are cached for offline viewing and fast switch-back: page bodies +
metadata, hierarchy/children/backlink listings, recent search results, comment
threads, engagement state, and the **attachment/avatar image disk cache**. Cache
is per workspace and best-effort — the app always refreshes from the network
when online and treats the cache as a fast-path, not a source of truth.

These bytes are **grant-checked, potentially confidential content**, so the
store is protected at rest (the security rationale is in §14):

- **`NSFileProtection`** on the store and image cache — baseline
  `completeUntilFirstUserAuthentication`, escalated to **`complete`** for a
  **confidential** workspace (§6.3) so its bytes are unreadable while locked.
- **Excluded from iCloud / iTunes backup** (`isExcludedFromBackup = true`).
- **Deleted on sign-out / remove-workspace** (and a confidential workspace's
  image bytes are ideally kept out of any shared on-disk cache entirely).

### §7.3 Schema versioning — drop-and-rebuild on mismatch

The `@Model` schema **will** change across app releases. SwiftData throws at
container init on a schema change unless a `VersionedSchema` /
`SchemaMigrationPlan` is provided — which, untreated, would **launch-crash
existing users** on the first schema-changing release. Because the cache is
**best-effort, not a source of truth** (§7.2), v1 does **not** write migration
plans: on a **schema-version mismatch the app DROPs the store and rebuilds it
from the network**. A small persisted `schemaVersion` marker (outside the
SwiftData store) is compared at launch; on mismatch the per-workspace store
file is deleted and recreated empty, then repopulated by normal reads. This
keeps schema evolution free of launch-crash risk at the cost of one cold
re-fetch after an upgrade.

### §7.4 Writes are online, with conflict surfacing — no offline queue

v1 performs writes **online** and surfaces conflicts (§8); it does **not**
implement an offline mutation queue / background sync engine. An edit made with
no connectivity fails fast and is retried by the user when back online. A
durable offline-edit-replay engine is deliberate future work, not v1 scope
(§2.2).

## §8 Editing without collab — the REST optimistic-lock path

v1 edits through the existing REST write endpoints, **never** through realtime
collab:

- **Create**: `POST /api/v2/pages` with `{ path, body }` (optional `grant`).
  Beyond success, the create handler
  (`packages/api/src/hono/handlers/page.ts:446-499`) returns **four distinct
  `400`s** the phone quick-create UX must each handle — it is *not* just
  success-or-conflict:
  - **`PAGE_EXISTS`** (`:459`, and the collapsed case at `:492-495`) — a page
    already exists at that path. **UX**: offer "open the existing page" / "edit
    it instead" rather than a dead-end error. **Non-obvious grant-race subtlety**:
    the handler **deliberately collapses** a *not-granted* page into the **same**
    `PAGE_EXISTS` (`:492-495` — "page is not granted for the user" → `PAGE_EXISTS`)
    so it never leaks the existence of a stricter-grant page the user cannot see.
    So `PAGE_EXISTS` means **either** a page the user can open **or** one they
    cannot — the app must **not** promise the page is openable; on the follow-up
    open it may itself `404`/be denied, which the UX treats as "that path is
    taken, choose another."
  - **`PAGE_TWIN_EXISTS`** (`:468`) — the **trailing-slash twin** collision: the
    target's `/x` ↔ `/x/` counterpart already exists as a real page, and Crowi
    refuses to create the double-state (`Page.findExistingTwin`). This is
    non-obvious to a phone user typing a path. **UX**: surface "a page already
    exists at `<twin.path>`" (the response carries the conflicting twin path) and
    offer to open *that* page instead of silently failing.
  - **`NON_EXISTENT_USER_PAGE`** (`:488`) — a `/user/<name>/…` path whose owning
    user page does not exist. **UX**: explain the parent user page is missing
    rather than showing a generic failure.
  - **`INVALID_GRANT`** (`:452`) — the supplied `grant` is not one of the valid
    values. **UX**: this is an app-side bug (the picker should only emit valid
    grants), so guard it client-side; if hit, fall back to the default grant.

  (A residual `PAGE_CREATE_FAILED` `400` covers any other server-side failure
  message, `:495`.) None of these is the `revision_id` optimistic-lock conflict
  — that is a **quick-edit** concern only, below.
- **Quick-edit**: `PUT /api/v2/pages` with `{ page_id, body, revision_id }` —
  the `revision_id` captured when the page was opened is the **optimistic
  lock**. This creates a revision directly, bypassing the Y.Doc; a subsequent
  collab editor on the web diffs against the new body string. RFC-0010/RFC-0003
  bless this non-collab write path.
  - **Hard client requirement: `revision_id` is mandatory on every edit.**
    `UpdatePageRequestSchema.revision_id` is **optional** server-side
    (`z.string().optional()`, `packages/api-contract/src/schemas/page.ts:288,323`):
    if the field is **omitted**, `PUT /pages` performs **no conflict check** and
    **silently overwrites** whatever the latest revision is — precisely the
    "must not silently overwrite" failure the conflict UX below exists to
    prevent. The optimistic lock is therefore **client-enforced**: the app
    **MUST always send** the `revision_id` it captured at open time and **MUST
    never** send an edit with `revision_id` absent (or stale-but-unverified).
    Omitting it is a client bug, not a fast path. The whole §8 conflict story
    is contingent on this invariant holding in the app.
  - **The lock source must be the *detail-endpoint* revision — a list-supplied
    revision is not valid.** `PageSchema.revision` is
    `z.union([z.string(), RevisionSchema]).optional()`
    (`packages/api-contract/src/schemas/page.ts:129`): **list / portal / children
    endpoints may return `revision` as a bare *string id* with no `body`** (and
    no `renderedAst`) — those fields are emitted **only** on the single-page
    detail `GET` (`page.ts:97-99` comment; the detail handler populates
    `body` / `renderedAst` only on that path, `page.ts:185-199`). Two
    consequences the editor MUST honor:
    1. A page opened *from a list* may carry a bare-string `revision` and **no
       body**, so the app **MUST issue a detail `GET` before entering edit** —
       the detail response is what returns the full `RevisionSchema` *with* the
       `body` to seed the editor.
    2. The optimistic-lock base is that **detail revision id captured when the
       editor opens**, not a list-supplied string. `PUT /pages` validates it via
       `pageData.isUpdatable(revision_id)` (`page.ts:517`), which compares the
       submitted id against the page's **current latest revision**; a stale id
       carried over from a list payload is therefore not a valid lock source and
       would either spuriously `409` or (if it happened to match) defeat the
       check's intent. "The `revision_id` captured at open time" means precisely
       **the detail-GET revision id read when the editor was opened**.
- **Comment**: `POST /api/v2/comments`.
- **Engagement**: `POST /pages/like` / `/pages/unlike`
  (`packages/api-contract/src/contracts/page.ts:322,353`), `POST /pages/seen`
  (`:262`), `PUT /pages/watch` (`:384`), `POST`/`DELETE /bookmarks`. These are
  low-risk single-shot toggles with no conflict model.

**Conflict handling (the load-bearing UX).** When the page changed
server-side between open and save, `PUT /pages` returns a revision error —
`PageRevisionErrorSchema` with `error.code === 'PAGE_REVISION_ERROR'`
(`packages/api-contract/src/schemas/page.ts:404-409`). On this error the app
**must not silently overwrite**: it re-fetches the current revision, tells the
user the page moved underneath them, and offers re-apply-on-the-new-base or
abort (abort by default — the same stance as the CLI's `crowi edit`,
RFC-0012 §7). This is the explicit cost of "no collab in v1": two people editing
the same page on web + app can collide, exactly as the CLI and raw API can
today — accepted, and made visible rather than hidden.

> The realtime path it avoids: collab is Hocuspocus/Yjs over
> `wss://<host>/collab/<pageId>?token=<wsToken>`, where `wsToken` is a 5-minute
> JWT from `GET /pages/{id}/yjs-token`
> (`packages/api-contract/src/schemas/collab.ts:50,62`). There is no Swift Yjs
> binding, so collab — including presence/awareness — is out of v1 entirely.

## §9 Multiplatform architecture (iPhone + iPad now, macOS-ready)

Multiplatform-readiness is a **core architectural decision**, baked in from the
first commit, not later scope creep.

- **One SwiftUI source, universal in v1.** iPhone and iPad ship from a single
  source as a universal app. Layout is **adaptive**: a `NavigationSplitView`
  (sidebar + content + detail) on iPad and regular-width size classes,
  collapsing to a `NavigationStack` on iPhone / compact width. The workspace
  switcher, page tree, and reader all adapt by size class rather than by a
  separate codebase.
- **100% shared across platforms**: the model layer, networking (§5), the
  SwiftData persistence (§7), auth/Keychain (§4), and the multi-workspace layer
  (§3). None of these contain platform-specific code.
- **macOS (and later visionOS) reached from the same source.** A macOS build is
  an additional Xcode multiplatform **target** over the *same* source, plus
  modest `#if os(macOS)`-conditional idiom deltas: menu-bar `Commands`, multiple
  windows, keyboard shortcuts, hover / right-click, and any
  `UIViewRepresentable` → `NSViewRepresentable` bridges. It is never a separate
  source tree.
- **Architecture rule to enforce**: adaptive navigation, clean model/view
  separation, and **all** platform-specific UI isolated behind OS-conditional /
  size-class boundaries. This is what makes iPad nearly free in v1 and macOS an
  increment rather than a rewrite.
- The whole chosen stack — SwiftData, swift-markdown-ui,
  `ASWebAuthenticationSession`, swift-openapi-generator, Keychain — is iOS +
  macOS capable, so nothing in the technology choices blocks the Mac.

## §10 Repository layout — an in-monorepo tooling island

The app lives **in this monorepo** at `apps/apple/`, as a **tooling island**:
turbo / pnpm do not manage it, Xcode / SwiftPM own the Apple build, and a
separate macOS CI job is path-gated on `apps/apple/**`.

- **Why in-monorepo (not a separate repo).** Keeping the api / api-contract /
  web implementation as **in-tree reference context** (including for
  agent-assisted development) and allowing **atomic contract + client changes**
  outweighs the tooling-mismatch friction. `packages/api-contract/openapi.json`
  is consumed **in-tree** as the shared build input (a generation step
  regenerates the Swift client from it), so there is no pinning and no drift —
  a contract change and its Swift-client consequence live in one change set.
- **The turbo/pnpm carve-out is a real constraint, and it is only partial.**
  `pnpm-workspace.yaml` globs `apps/*` and `packages/*`, so an `apps/apple/`
  with a `package.json` would be pulled into the pnpm workspace and turbo's
  task graph automatically. Not giving the directory a `package.json` (it is a
  SwiftPM / Xcode project, not an npm package) keeps it out of the **pnpm
  workspace and the turbo task graph** — so turbo never builds, lints, tests, or
  caches the **Swift** sources. **That carve-out is `package.json`-scoped and
  therefore covers only `.swift` (and other non-JS) files.** It does **not**
  make the directory invisible to the repo's *file-glob*-driven tooling:
  - **Biome formatting/linting is filesystem-glob, not package-scoped.**
    `biome.json` includes `apps/**/*.{ts,tsx,js,jsx}` (`biome.json:10`)
    independently of any `package.json`, so **any `.ts/.tsx/.js/.jsx` file
    placed under `apps/apple/`** (a codegen script, a fastlane/CI helper, a
    config) **would** be matched by `pnpm format` / `pnpm lint`.
  - **The lefthook pre-commit format job is staged-file-glob.** It runs
    `biome format --write` over staged `*.{ts,tsx,js,jsx}` (`lefthook.yml:7,13`),
    again regardless of `package.json`, so a staged JS/TS tooling file under
    `apps/apple/` **would** be reformatted by the existing hook.

  The accurate statement is therefore: the Apple **build** (Swift) is fully
  carved out via the absent `package.json`; but **any JS/TS tooling file** that
  lands in `apps/apple/` is *intentionally in-scope* for the shared
  Biome/lefthook formatting + lint rules (which is harmless — consistent
  formatting of a codegen script is fine), unless it sits under an
  already-excluded path (`**/generated/**`, `**/node_modules/**`, etc.). If that
  coupling is ever unwanted, the options are to add an explicit
  `!apps/apple/**` Biome ignore + a lefthook `exclude`, and/or — only if a
  `package.json` is later needed inside `apps/apple/` — to narrow the workspace
  globs to exclude it. This is exactly what OQ-5 (§16) tracks: it is **not**
  asserted here as already-settled.
- **CI.** A separate, **path-gated** macOS runner job builds **and tests** the
  app only when `apps/apple/**` changes (it needs Xcode, which the existing Linux
  jobs do not have). The Node/turbo CI is unaffected. The macOS job also runs
  the swift-openapi-generator step, so a contract change that breaks generation
  (§5.1) fails CI.
- **The generated Swift client is build-time-generated and NOT committed.** The
  SwiftPM plugin regenerates it from the in-tree `openapi.json` on every build
  (matching the generator's own model); the repo never vendors the generated
  sources, so there is nothing to drift or hand-edit.
- **Swift test / CI policy.** The macOS job runs `swift test` plus targeted
  UI / snapshot tests that **guard the load-bearing client invariants** this RFC
  relies on: the **lenient response decoder** (unknown/missing fields, version
  skew, §5.2), the **single-flight OAuth token refresh** under concurrent `401`s
  (§5.1, so rotation/reuse-detection is never tripped), the **same-origin Bearer
  + origin-change-redirect-strip** image rule incl. the same-origin `/files/<id>`
  hop (§6.1), the **`revision_id`-required edit** invariant (§8), and
  **per-workspace cache isolation** (host A's store never serves host B, §3/§7).
  These are exactly the rules whose violation is a silent security or
  data-integrity bug, so they are test-pinned, not left to manual review.
- **The RFC itself** lives in `docs/rfcs/` (this file).

### §10.1 Explicitly NOT a polyglot build system (Bazel/Buck/Pants)

A polyglot build graph (Bazel/Buck/Pants) is **rejected**: the Apple app and
the backend share **no compile-time dependency**. The boundary between them is
the **runtime HTTP API plus the `openapi.json` data file** — the app links
nothing from `packages/*`; it generates Swift from a checked-in JSON artifact.
A cross-language build graph would add ceremony (BUILD files, a second build
tool, hermeticity rules) without buying any capability at this scale. This is
revisited only if a genuine cross-language *compile-time* dependency ever
appears between the iOS and backend code (today there is none).

### §10.2 App Store distribution & review

The app is an **arbitrary-host connector** (the user types any Crowi URL), which
needs deliberate handling for App Review and store policy:

- **Arbitrary-host connection, explained for review.** Like an email or Git
  client, the app connects to a server the *user* supplies; it ships with no
  default backend. App Review needs a **working demo/review workspace** — a
  hosted Crowi instance with seeded content and a review login — so the reviewer
  can exercise the app without standing up a server. The review notes explain
  the connect-any-host model up front.
- **App Transport Security exceptions are narrow.** ATS stays **on** (HTTPS
  enforced, §14). The only exception is the documented local/dev-host allowance
  (`localhost` / `127.0.0.1` / `*.local`); there is **no** blanket
  `NSAllowsArbitraryLoads`. The OAuth callback is the **custom scheme**
  `crowi-ios://callback` (an in-app scheme handoff via ASWAS, §4.1), not a
  network request, so it is outside ATS and needs no exception; the app's
  `CFBundleURLTypes` declares the scheme.
- **Confidential-workspace screenshot/recording suppression.** For a
  confidential workspace (§6.3) the app marks sensitive views
  screenshot/recording-excluded and suppresses content export (§14 / OQ-11); the
  review notes explain this is a corporate-compliance control, not an attempt to
  evade review.
- **Sign-in via the host web page.** Because auth happens in
  `ASWebAuthenticationSession` against the host's own login (§4), the app uses the
  system-blessed auth-session API rather than a custom web login, which is the
  pattern App Review expects for third-party sign-in.

## §11 Notifications — REST poll in v1, APNs deferred

- **v1 = foreground REST polling.** While foregrounded the app pulls
  `GET /notifications` (list), `GET /notifications/status` (unread count),
  and marks read via `POST /notifications/{id}/open` / `POST /notifications/read`.
  Notification kinds are COMMENT / LIKE / MENTION / UPDATE.
- **Optional WS invalidation signal.** Crowi already exposes a notifications
  WebSocket (`packages/api/src/notifications/attach.ts`) that emits a bare
  "changed" signal telling a connected client to refetch; the app may
  optionally use it as a foreground "refetch now" nudge instead of fixed-interval
  polling. It is not push — it requires a live, foreground connection.
  - **Hard requirement: the client MUST proactively re-mint the WS auth token.**
    The connection authenticates with a JWT from `GET /notifications/token`
    (`packages/api-contract/src/contracts/notification.ts:165-173`) whose TTL is
    only **60 seconds** (`NOTIFICATIONS_TOKEN_TTL_SECONDS = 60`,
    `packages/api/src/util/notifications-token.ts:24-32`). A connection that
    mints once and never refreshes therefore **drops within a minute**. While
    foregrounded the app **MUST** re-fetch the token and refresh the connection
    **ahead of the 60-second expiry** (the response's `expiresAt` is the
    re-mint trigger — re-mint well before it, e.g. ~30s, mirroring the web
    client). Without this the "refetch nudge" is dead after one minute and the
    app silently falls back to nothing; if the app does not want to run this
    short re-mint loop, it should **stay on fixed-interval polling** rather than
    half-using the WS.
- **APNs is explicitly out of v1 scope.** No APNs/FCM infrastructure exists in
  the codebase. True remote push would require **new server work**, sketched
  here only as future design:
  - a per-device, per-workspace token registration endpoint (e.g.
    `POST /me/push-token`);
  - an APNs provider in the backend (or a plugin);
  - a **workspace identifier embedded in `aps.userInfo`** so the app can route
    an incoming push to the right workspace (the Slack/Mastodon multi-account
    pattern) and open the correct host's content.
  Because each workspace is a different host with independent auth (§3),
  push routing is inherently multi-workspace and cannot assume a single global
  identity. This is a separate, non-trivial server RFC — deferred.

## §12 SwiftUI architecture summary

| Layer | Responsibility | Shared across platforms? |
|---|---|---|
| `@main App` + `WorkspaceStore` | ordered workspace list, active workspace, switcher, add/remove flow (§3) | yes |
| Auth / Keychain | per-workspace OAuth Auth-Code + PKCE via ASWAS + custom scheme `crowi-ios://callback` (trusted `crowi-ios`, no consent), RFC 8414 discovery + token storage + single-flight rotating-refresh + server-side revoke on logout (§4) | yes |
| Networking | one generated `Client(serverURL: apiBaseURL)` per workspace (build-time-generated, non-committed) + Bearer/OAuth-refresh transport + lenient response decoding (§5) | yes |
| Persistence | per-workspace SwiftData `ModelContainer` (§7) | yes |
| Image loading | per-workspace base-URL-rebasing loader covering **both** auth-gated shapes — `/attachments/<id>` (embedded) **and** `/attachments/by-key/<key>` (avatars) (§6.1); Bearer **same-origin-only**, stripped on cross-origin/redirect; raster-decode only, never an SVG/web context (§6.1/§14); routed in via the renderer's custom image-provider seam, the v1 GO/NO-GO of §5.1 / OQ-10 | yes |
| Rendering | native Markdown from raw `revision.body`, with an **http(s)+workspace-relative scheme allowlist** on links/images (§6, §6.2) | yes |
| Confidentiality banner | always-on, non-dismissible per-workspace **non-scrolling overlay** from `/app/info.confidential`; an in-app banner (not a screenshot/print guarantee), with optional system-export suppression for confidential workspaces (§6.3, OQ-11) | yes |
| Navigation / views | adaptive `NavigationSplitView`↔`NavigationStack` by size class (§9) | source shared; layout adapts |
| Platform idioms | menu bar / multi-window / shortcuts / hover, behind `#if os(...)` (§9) | macOS-only deltas |

## §13 Alternatives considered

- **React Native / Flutter (cross-platform UI toolkit).** Rejected, recorded
  for completeness. A native Swift + SwiftUI client gives first-class platform
  integration, a single SwiftUI source that scales iPhone → iPad → macOS (§9),
  and direct use of Apple's swift-openapi-generator against the committed
  contract; a JS/Dart toolkit buys none of that and adds a runtime.
- **Read-only v1 (defer all writes).** A strictly-read first release (plus
  low-risk engagement toggles) would remove all `409` conflict UX and the
  no-collab caveat, and ship the safest possible app. Rejected as
  *under-delivering*: a wiki client that cannot capture a quick edit or note
  from a phone is materially less useful, and the REST `revision_id` write path
  (§8) is fully supported and bounded. v1 ships read **plus** bounded write.
- **`WKWebView` rendering with the server's `renderedAst`/HTML.** Would give
  pixel-fidelity with the web app on Crowi-specific extensions. Rejected: it
  couples the app to **each host's renderer version** across N differing hosts
  (the exact skew §5 avoids), its Shiki styling is web-CSS-only, a per-cell
  `WKWebView` is heavy and breaks native scrolling/selection, and the web
  context wants a cookie the native app does not set — complicating the
  per-workspace Bearer image loading (§6.1). v1 renders raw Markdown natively
  and closes extension gaps incrementally (§6).
- **Auth mechanism for v1 — four options weighed (§4).** The deciding axes are
  credential safety (revocable / scoped / does the app touch the password) and
  coverage (does it work on the host's real login, incl. future SSO), traded
  against the size of any server change.
  - **CHOSEN — OAuth Auth-Code + PKCE via ASWAS + a custom-scheme callback,
    against a trusted `crowi-ios` client.** The app authenticates the user on the
    **host's own login page** inside an `ASWebAuthenticationSession`, capturing a
    **`crowi-ios://callback`** custom-scheme redirect (the standard iOS pattern —
    ASWAS delivers results only via a custom scheme or, on 17.4+, an https
    universal link; it cannot capture a loopback http callback). It covers
    password **and** any future RFC-0014 SSO with no app change, never touches the
    raw password, and receives a **rotating, reuse-detected,
    individually-revocable, scope-bounded** token pair
    (`oauth-refresh-token.ts:7-26,120-146`; scopes requested up front,
    `oauth.ts:172`, so no `403`). The trusted client skips consent. Cost: the
    **bounded API + WEB companion changes** of §4.4 (seed `crowi-ios` +
    custom-scheme redirect, relax the redirect validator for trusted clients,
    auto-approve in API + web), shipping in the min Crowi version — no per-host
    operator action.
  - **REJECTED — password login (`POST /auth/login`).** Earlier drafts chose
    this. Rejected: the app would handle the user's **raw password**, the
    resulting credential is a **non-revocable ~30-day `ALL_SCOPES` JWT** (refresh
    is verify-and-re-mint only — no rotation / reuse-detection / DB row,
    `tokenAuth.ts:223-247` + `jwt.ts:151-165`; the access JWT gets `ALL_SCOPES`,
    `auth.ts:138`), it **cannot cover host-side SSO** (there is no password to
    type under SSO), and `/auth/login` has **no server-side brute-force throttle**
    (the password verify path `tokenAuth.ts:75-130` runs no rate limiter — the
    rate limiter `rate-limit.ts` is wired only to autocomplete / attachment
    upload), so funneling app logins through it concentrates an unthrottled
    password-guessing surface. OAuth moves authentication onto the host's login
    page (whose protection is the host's responsibility) and yields a far safer
    credential.
  - **REJECTED — OAuth *with consent* via the existing `crowi-cli` client.**
    Genuinely **zero-server-change** (reuses the seeded `crowi-cli`,
    `oauth-client-seed.ts:23-44`), and it was tempting to claim "no companion
    change at all". Rejected because `crowi-cli` is `trusted: false`
    (`:39`), so the user would face the **consent screen on every login** (no
    stored grant is remembered) and would be authorizing under the **CLI's
    identity**, not the app's. The bounded, code-anticipated companion change
    (§4.4) buys a no-consent, correctly-identified first-party experience — worth
    it over per-login consent friction. (It also doesn't solve the redirect
    transport — `crowi-cli` registers only loopback hosts, which ASWAS cannot
    capture.)
  - **REJECTED (as the redirect transport) — loopback / local-listener, and
    https universal-link.** A **loopback `http://127.0.0.1` callback** is the
    CLI's transport, but it requires running a real local HTTP server **without**
    ASWAS, which loses ASWAS's ephemeral cookie isolation and has a weaker
    App-Review posture for an arbitrary-host client — so it is a recorded
    fallback, not the default (§4.4). An **https universal-link callback**
    (ASWAS-capturable on iOS 17.4+) needs an **app-owned associated domain**,
    which the app cannot host on an arbitrary Crowi origin, so it does not fit
    the connect-any-host model. The **custom scheme `crowi-ios://callback`** is
    the chosen transport; it needs the §4.4 validator relax (today the validator
    rejects all non-`http(s)` schemes, `oauth-redirect-uri.ts:34-36`), which is
    part of the accepted companion change.

  (The old "zero-server-change is decisive / password is the only zero-change
  option" framing is dropped — it was false: OAuth is *also* zero-change against
  `crowi-cli`. We accept the bounded companion changes to get no-consent + the
  safer, revocable, scoped credential + the ASWAS-native custom-scheme
  transport.)
- **Separate `crowi-ios` repository** with the `openapi.json` pinned (submodule
  or copied + regenerated). Avoids the Xcode/SPM-vs-turbo tooling mismatch, but
  loses in-tree reference context and forces non-atomic contract↔client changes
  (a spec bump in this repo and a client regen in another). Rejected in favor of
  the §10 in-monorepo tooling island, which keeps the contract and its consumer
  together with no pinning.
- **A polyglot build graph (Bazel/Buck/Pants).** Rejected — see §10.1 (no
  compile-time dependency crosses the language boundary).

## §14 Security considerations

- **Per-workspace credential isolation.** Tokens live only in the Keychain, one
  item per workspace (§4.3); the per-workspace client (§5) makes it
  structurally impossible to present host A's token to host B. Sign-out deletes
  exactly one item and never affects another workspace.
- **HTTPS is required for a workspace origin (transport-security default).** A
  workspace's `workspaceOrigin` **must be `https`** in v1; the app rejects (or
  warns on) a cleartext `http` origin **before any auth** (§3), permitting `http`
  only for an explicit local/dev host (`localhost`, `127.0.0.1`, `*.local`)
  behind a documented App Transport Security exception. This is not optional
  polish: the OAuth authorization code and the access + refresh tokens travel
  to/from the workspace origin (and the discovery doc + authorize page + token
  endpoint), so sending them over cleartext would be a **larger** hole than the
  §6.1 same-origin-Bearer image guard already defends. (The `crowi-ios://callback`
  redirect is an on-device scheme handoff, not a network leg, and **PKCE S256
  binds the code to the app** so an interception of the callback by another app
  is useless without the `code_verifier`, §14.)
- **The stored credential is revocable + scope-bounded (a strength, and
  Keychain-only is still load-bearing).** v1's stored secret is the **OAuth
  refresh token**: scope-bounded to what the app requested
  (`oauth.ts:172`), **rotating + reuse-detected**, and **individually revocable**
  (`oauth-refresh-token.ts:7-26,120-146`). A leak is far less damaging than a
  stateless all-scopes JWT would be — the token can be revoked server-side
  without touching anything else, and rotation means a stolen-then-reused token
  trips `revokeChain` and kills the line. It is still stored **only** in the
  Keychain (never `UserDefaults`/files), never logged, and only ever sent over
  HTTPS, because a live refresh token is still a bearer secret.
- **Logout is a real server-side revocation.** Signing out (or removing a
  workspace) calls `POST /oauth/revoke` to revoke that workspace's refresh token
  server-side (§4.2) — unlike the stateless-JWT design, where sign-out only
  discarded the local copy. Combined with rotation, this gives **per-device /
  per-workspace revocation**: a lost phone is de-authorized for that one host by
  revoking its token, with **no** host-wide logout of other users and **no**
  global signing-secret rotation.
- **Authentication happens on the host's login page; the app POSTs no password.**
  The user's credentials are entered into the host's own `/oauth/authorize` web
  page inside the `ASWebAuthenticationSession`, not into the app. Brute-force /
  lockout protection on that login is therefore the **host's** responsibility
  (and is worth noting: the v2 `/auth/login` path itself has no built-in
  throttle today — `tokenAuth.ts:75-130`, with `rate-limit.ts` wired only to
  autocomplete/upload — so operators should front login with their own
  protection). The app neither sees nor stores the password, removing an entire
  class of in-app credential-handling risk.
- **Trusted-client skip-consent is standard first-party auto-approval, and is
  safe.** Skipping the consent screen for `crowi-ios` (§4.4) is the normal
  first-party pattern. Its safety rests on three things: (1) the client is
  **server-seeded** — an attacker cannot register or impersonate a `trusted`
  `crowi-ios` client, and the relaxed validator accepts the custom scheme **only
  for a trusted first-party client** (§4.4), not the public web; (2) the
  `crowi-ios://callback` scheme is **claimed by the installed app via its
  `Info.plist`** and delivered through ASWAS's `callbackURLScheme` capture, so a
  web body cannot inject into it (§6.2); (3) **PKCE S256** (`oauth.ts:189`) binds
  the code to the app's `code_verifier`, so even if another app on the device
  registered the same scheme and intercepted the callback, the code is useless
  without the verifier. Auto-approval grants only the scopes the app requests,
  which are fixed and visible in this RFC. (A residual, accepted iOS limitation:
  custom URL schemes are not exclusively ownable — a malicious app *could* also
  claim `crowi-ios://` — which is exactly why PKCE S256, not scheme ownership, is
  the interception defense; the https-universal-link alternate of §4.4 would add
  exclusive ownership but does not fit the connect-any-host model.)
- **No admin surface.** The app is a normal user session; admin endpoints are
  not targeted or built.
- **No request-`Host`-derived URLs.** Endpoint URLs are always built from the
  workspace's stored, user-entered base URL, never from a response or a
  redirect's `Host` — mirroring the server-side rule that all OAuth URLs derive
  from configured `CLIENT_URL`, not the request `Host` (RFC-0010). The
  add-workspace step validates the host via `/app/info` before any credential
  is sent.
- **Attachment fetches are authorized, and the Bearer is same-origin-only.**
  Images are fetched with the active workspace's Bearer token against that
  workspace's base URL (§6.1), for **both** auth-gated shapes — embedded
  `/attachments/<id>` and avatar `/attachments/by-key/<key>`
  (`attachment-stream.ts:120`); neither has a public/CDN URL. The two differ in
  *depth* of server check: the embedded path is **page-grant-checked**
  (`loadGrantedPage`, `attachment-stream.ts:198`, in the authenticated stream
  `:173-228`), whereas the by-key avatar path is **Bearer + `user/`-prefix only,
  not grant-checked** (`:128-161`) — acceptable because avatars are not
  per-page-secret. The load-bearing rule that makes "cannot leak cross-grant
  bytes" true: because page bodies are **author-controlled and unsanitized**
  (render-mdast.ts:166, no `rehype-sanitize`) and may embed an **absolute
  external** image URL, the loader attaches the Bearer **only** for requests
  whose origin exactly equals the workspace base-URL origin, sends it on **no**
  cross-origin URL, and **strips it on any origin-changing redirect** (§6.1).
  Without that rule a malicious body could exfiltrate the workspace token to an
  attacker host; with it, the token never leaves its own origin.
- **Rendered link/image URL schemes are allowlisted (untrusted-body defense).**
  Rendering raw Markdown (§6) — not arbitrary server HTML in a `WKWebView` —
  keeps the app off the web renderer's "no `rehype-sanitize`, trust-based HTML"
  path, so a malicious body cannot execute script in a web context inside the
  app. That addresses inline-HTML script execution **but not** malicious URL
  **schemes** in otherwise-valid Markdown links/images. v1 therefore enforces an
  **http(s) + workspace-relative scheme allowlist** on every rendered link and
  image (§6.2): `javascript:` / `file:` / `data:` / **all** custom schemes are
  inerted to plain text / broken-image and never handed to `UIApplication.open`
  / `Link` / `AsyncImage`. v1 **does** register the `crowi-ios://` OAuth-callback
  scheme (§4.1), so this is load-bearing: the allowlist **inerts `crowi-ios://`
  in bodies**, so a body cannot forge an auth-callback deep link — and in any
  case the callback reaches the app only via ASWAS's `callbackURLScheme` capture
  of a session the app started, not via a tapped body link (§6.2).
- **Attachment bytes are raster-decoded only — never a web/SVG-DOM context.**
  The stream serves the stored `Content-Type` `inline` and **SVG is an accepted,
  un-sanitized upload type** (`attachment-stream.ts:53,224-225`), so an uploaded
  `<svg><script>` is untrusted active content. v1 decodes attachment bytes
  through a **raster image decoder only** (`UIImage`/`Image`), never a
  `WKWebView` / SVG-DOM renderer, so such a payload cannot execute (§6.1). This
  is a durable invariant: **any future "open attachment" / Quick Look / share /
  web-preview path MUST keep attachment bytes out of every web/SVG-DOM context.**
- **OAuth webview hardening (v1).** The Authorization-Code flow runs in an
  **ephemeral `ASWebAuthenticationSession`** (no shared cookies with Safari),
  captures the `crowi-ios://callback` custom scheme via ASWAS's
  `callbackURLScheme` (so only the app receives it), validates that `state`
  round-trips, and uses **PKCE S256** (the interception defense — §14); the
  resulting tokens land in the per-workspace Keychain slot. Endpoints are taken
  from RFC 8414 discovery (§4.1), never assumed.
- **SwiftData cache data-at-rest (the cache holds grant-checked secret bytes).**
  The per-workspace store caches **page bodies, comments, search results, and
  the attachment/avatar image disk cache** — i.e. grant-checked, potentially
  confidential content (and the attachment stream sets **no** `Cache-Control:
  private`, `attachment-stream.ts:221-228`, so caching is the client's
  responsibility to bound). v1 therefore:
  - applies **`NSFileProtection`** to the store and the image cache — baseline
    `completeUntilFirstUserAuthentication`, and **`complete`** for a
    **confidential** workspace (§6.3) so its bytes are unreadable while the
    device is locked;
  - **excludes the cache from iCloud / iTunes backup**
    (`isExcludedFromBackup = true`) so secret bytes do not leave the device in a
    backup;
  - **deletes a workspace's store + image cache on sign-out / remove-workspace**
    (the §7 cache-deletion policy), and ideally **keeps confidential-workspace
    bytes out of any shared on-disk image cache** entirely (memory-only or a
    protected per-workspace cache).

## §15 Phased plan

- **Phase 0 — server companion + transport/generator gates.** Land the
  **companion changes** (seed `crowi-ios` + custom-scheme redirect, relax the
  redirect validator for trusted clients, auto-approve in **API + web**, §4.4) in
  the minimum Crowi release, and clear the three gates: the **redirect-transport
  gate** (ASWAS + `crowi-ios://callback` end-to-end, incl. the validator relax
  and the web auto-submit — §4.4), **swift-openapi-generator 3.1 generates from
  the real `openapi.json`** (§5.1), and the **renderer spike** (MarkdownUI vs
  Textual, image-path + extensions, §5.1 / §6).
- **Phase 1 — Multi-workspace shell + read.** `WorkspaceStore`, add-workspace
  via **HTTPS-only** `/app/info` validation + **min-version gate** (§3 / §4.4),
  per-workspace **OAuth Auth-Code + PKCE sign-in via ASWAS + `crowi-ios://callback`
  with RFC 8414 discovery (§4) — the sole v1 auth** — with **single-flight
  rotating-refresh** and server-side revoke on logout, per-workspace generated
  client against `apiBaseURL` (§5) + lenient decoding, and a per-workspace
  SwiftData container with **`NSFileProtection` + backup-exclusion** (§7 / §14). Full **read**: page open + native Markdown
  render (§6) **with the link/image scheme allowlist (§6.2)** **and navigable
  internal links — `[[wikilinks]]` and `@mentions` resolve to in-app
  navigation** (a read-first wiki client needs internal links to work),
  hierarchy/portals/children/backlinks, search (capability-gated on the
  **refreshed** `/app/info` cache, §5.2), revisions, comments (read),
  bookmark/like/seen state, profile + recently-viewed. Attachment + avatar image
  loading with the **same-origin-only Bearer rule (§6.1)**. The always-on
  **`confidential` banner driven by the refreshed `/app/info` cache (§5.2 /
  §6.3)**. Adaptive iPhone/iPad layout (§9). Slack-style workspace switcher with
  independent sign-out.
- **Phase 2 — Bounded write.** Create page (`POST /pages`) with the four-`400`
  create-failure UX (§8), quick-edit with `revision_id` optimistic lock and
  explicit `PAGE_REVISION_ERROR` conflict UX (§8), comment creation, and
  engagement toggles (like/seen/watch/bookmark).
- **Phase 3 — Notifications + heavier extensions.** Foreground REST notification
  list + unread badge + read/open (§11) with the **60s WS-token re-mint** (§11),
  optional WS "refetch" signal, and incremental native handlers for the
  **heavier** Crowi-specific Markdown extensions (footnotes, **PlantUML**, image
  display attributes — §6). (Internal-link navigation already shipped in
  Phase 1.)
- **Future (out of v1 scope, separate work).** macOS multiplatform target +
  idiom deltas (§9); the **device-authorization "scan to sign in" cross-device
  flow** (RFC 8628 is already server-implemented — only QR + wiring remain, §4.5);
  PAT / scoped-credential auth if ever wanted; APNs remote push with the
  multi-workspace routing design of §11; an offline write-sync engine (§7.4).

## §16 Open questions

1. **OQ-1 — Native-extension coverage schedule (§6).** Given the renderer chosen by the
   OQ-10 spike, which Crowi-specific extensions are native at which phase —
   internal links (`[[wikilinks]]` / `@mentions`) are **Phase 1** (§15); footnotes
   / PlantUML / RFC-0015 image-display-attributes are later — and which degrade
   to plain text until then. The *approach* (native, raw body) and the Phase-1
   internal-link requirement are decided; the per-extension order is open. (The
   lenient-decode implementation seam is tracked separately in OQ-8.)
2. **OQ-2 — Workspace-index storage (§3).** The non-secret ordered workspace index —
   a tiny dedicated SwiftData store, an app-group `UserDefaults`, or a plist —
   and whether it should be shared with a future share-extension / widget
   (which would push it into an app group). Open.
3. **OQ-3 — Token-refresh single-flight — PHASE-1 REQUIREMENT, not just an OQ (§4.2 /
   §5.1).** With OAuth, concurrent refreshes are **dangerous**, not merely
   wasteful: refresh tokens **rotate and are reuse-detected**
   (`oauth-refresh-token.ts:7-26,120-146`), so two requests that each present the
   same refresh token would make the second look like a stolen-token replay and
   trip `revokeChain`, revoking the whole workspace. The app **MUST** serialize
   refreshes through an actor (one in-flight refresh; other `401`s await its
   result). This is a hard Phase-1 deliverable and a CI-tested invariant (§10);
   the only open part is the exact Swift primitive (actor vs. a single-flight
   task), not whether to do it.
4. **OQ-4 — Cache eviction / store growth (§7.2).** Per-workspace cache size bounds and
   eviction policy (and whether removing a workspace deletes its store file
   immediately or lazily). Open.
5. **OQ-5 — `apps/apple/` workspace carve-out mechanics (§10).** The `package.json`-free
   carve-out is confirmed for the **build** (pnpm workspace + turbo task graph
   key off `package.json`), but it is **not** total: Biome's filesystem glob
   `apps/**/*.{ts,tsx,js,jsx}` (`biome.json:10`) and the lefthook pre-commit
   format job's staged-file glob `*.{ts,tsx,js,jsx}` (`lefthook.yml:7,13`) both
   reach **any JS/TS tooling file** under `apps/apple/` regardless of
   `package.json` (§10). The remaining decision is product/ergonomics, not a
   factual unknown. **Default (chosen): the shared Biome/lefthook format/lint
   also reach the Apple-side JS/TS tooling files** — consistent formatting of a
   codegen / fastlane / CI helper is harmless. The **opt-out**, only if that
   coupling ever proves unwanted, is an explicit `!apps/apple/**` Biome ignore +
   a lefthook `exclude` (and, only if a `package.json` is ever added there,
   narrowing the `pnpm-workspace.yaml` globs). Still to confirm: that no release
   script reaches into `apps/*` independently of a `package.json`.
6. **OQ-6 — Minimum supported Crowi version — the exact floor string (§4.4 / §5).** The
   floor is fixed *in kind*: the 2.0.x release that seeds the `crowi-ios` client
   and wires the `trusted` skip-consent path (§4.4); a host below it is refused
   at add-time with no fallback. The open part is the **concrete version string**
   (filled in when that release is cut) and the *upper* skew beyond which the app
   merely warns (mirroring RFC-0012's "supported skew policy" — keyed on
   `/app/info.version`, §5.2).
7. **OQ-7 — swift-openapi-generator 3.1 generation — Phase-1 GO/NO-GO (§5.1).** Does the
   generator produce a buildable client from the real `openapi.json` (3.1.0,
   ~158 `anyOf`, ~4 `oneOf`, ~462 type-arrays, ~86 `null`-types, the
   `Page.revision` union, `TokenRequest` `oneOf`, date/string/null)? If not,
   which fallback — 3.0 down-convert, thinned client spec, limited-operation
   generation, or a hand-written client — and at what cost? Settle before
   committing to generation.
8. **OQ-8 — Lenient-response-decode seam in Swift (§5.1 / §5.2).** The generated
   response types are strict; the app needs tolerant decoding for version skew.
   Where does the tolerant decoder live — a custom decoder layer over the
   generated transport, hand-written tolerant models for the screens read, or
   relaxed-to-optional generated types? Note the generator's value may be mostly
   request/path-centric. A Phase-1 spike pins this.
9. **OQ-9 — `tel:` / `mailto:` scheme allowlist opt-in (§6.2).** The link/image scheme
   allowlist inerts everything outside `http(s)` + workspace-relative by
   default, which includes `tel:` and `mailto:`. Whether to add those two as a
   deliberate opt-in (a phone-number or email link in a wiki body is a plausible
   convenience, and both are far lower-risk than `javascript:` / `file:` /
   `data:`) is an open product decision. Default stance: inerted, like all other
   non-`http(s)` schemes, until explicitly opted in.
10. **OQ-10 — Renderer image path + LIBRARY choice — v1 GO/NO-GO (§5.1 / §6.1).** Every
   embedded image is auth-gated with no anonymous/CDN URL
   (`attachment-stream.ts:173-228`), so v1 image rendering depends on routing the
   renderer's own image fetch through the per-workspace loader **carrying the
   §6.1 same-origin-Bearer rule + origin-changing-redirect strip per request**
   (the §14 token-exfiltration defense), not just a base URL. The spike must
   answer, **for both candidate libraries** — swift-markdown-ui/MarkdownUI (now
   in **maintenance mode**) and the **Textual** fork (active development), so the
   renderer is **not pre-locked**: (a) **can the provider closure
   (`.markdownImageProvider` / `ImageProvider`) carry per-request async auth and
   hook the `URLSession` redirect delegate** — a plain `URL → Image` closure
   cannot install the redirect-strip guard and is insufficient; (b) **can the
   renderer be bypassed for images entirely — does it surface image *nodes*** so
   the app fetches them with its own controlled `URLSession` view? If a library
   offers only the provider closure (no redirect hook, no node access), **both
   the primary and the fallback are at risk** and the §6.1 guards may be
   uninstallable. The spike also weighs native-extension coverage (§6); the
   renderer choice is **decided by the spike**, before committing in Phase 1.
11. **OQ-11 — Confidential-workspace enforcement depth — including refuse-to-open
   (§6.3).** The non-scrolling banner overlay is the v1 floor and ships
   unconditionally for confidential workspaces; beyond it, how far to take
   content-export suppression (disable copy / share / Quick Look, mark views
   screenshot/recording-excluded) is a product/compliance decision — a SwiftUI
   in-app banner cannot match the web header's screenshot/print guarantee (§6.3).
   An explicit option on the table if the overlay + export-suppression are judged
   **insufficient** to enforce the control: **v1 refuses to add / open a
   confidential workspace at all** (treat `confidential != null` as
   not-supported-in-v1). Settle the depth — up to and including refuse-to-open —
   with the compliance owner; it is not an architectural blocker.
12. **OQ-12 — iOS 17 floor vs. enterprise reach (§7.1).** The SwiftData-driven iOS 17 /
   macOS 14 floor excludes older devices. Confirm against the target
   organizations' deployed-OS share before launch (a release-checklist item),
   and decide whether the reach cost is acceptable or warrants a Core Data path
   for an older floor.

Resolved since an earlier draft:
- The **auth model is settled: OAuth 2.0 Authorization-Code + PKCE via ASWAS +
  the custom-scheme `crowi-ios://callback`, with RFC 8414 discovery, against a
  trusted `crowi-ios` client** (§4). This resolves several earlier
  questions outright: the credential is now **revocable + scope-bounded**
  (so the old "no per-device revocation" and "stateless logout" caveats are
  gone — logout revokes server-side, §4.2/§14); the app **never POSTs a
  password** (so the `/auth/login` brute-force exposure is moot — host login,
  and its protection, is the host's responsibility, §14); SSO/social work for
  free on the host's login page (so the "SSO-only users locked out" worry does
  not arise); and because the app requests its scopes up front, **`403
  INSUFFICIENT_SCOPE` never occurs** (so the old scope-shortfall-UX concern,
  which only applied to an opaque pasted PAT, is out of scope). PAT is not in v1.
- The `/app/info` **refresh trigger + cadence** is specified (re-fetch on
  activation / foreground + a 10-minute TTL; the confidential banner and all
  capability gates read that refreshed cache — §5.2 / §6.3).
- **Token-refresh single-flight** moved from an open question to a **Phase-1
  requirement** (OQ-3) — mandatory under OAuth refresh-token rotation/reuse-detection.

## §17 References

- Code (auth — §4):
  `packages/api/src/hono/handlers/oauth.ts:385-404` (RFC 8414 discovery —
  `authorization_endpoint` is a **web-origin** page, `token_endpoint` is under
  `/api/v2`, same-origin only "in the default deployment" `:387-399`; the app
  resolves both from here, §4.1) + `packages/web/next.config.ts:85` (dev proxy of
  the discovery doc to the web origin) + `packages/cli/src/lib/oauth.ts:227-236`
  (the CLI resolving authorize/token from discovery — the model the app follows),
  `packages/api/src/util/oauth-redirect-uri.ts:34-53` (redirect validation —
  **non-`http(s)` rejected `:34-36`**, so `crowi-ios://callback` is refused today;
  §4.4's companion change relaxes this to allow a custom scheme **for a trusted
  first-party client only**),
  `packages/api/src/util/oauth-client-seed.ts:23-44` (today seeds only
  `crowi-cli` as `firstParty:true, trusted:false` `:38-39`; v1's companion change
  adds a `trusted` `crowi-ios` client with the `crowi-ios://callback` redirect),
  `packages/api/src/models/oauth-client.ts:31-32` (the **reserved-but-inert**
  `trusted` flag — comment "even a trusted client still shows the consent screen
  in v1"; §4.4 wires it),
  `packages/api/src/hono/handlers/oauth.ts:166-222` (authorize handler — a
  **POST**, web-session-only JSON endpoint returning `{redirectUri}` `:166-170`,
  **not** a login page; reads scopes `:172`, records granted scopes on the code
  `:206`, PKCE S256 `:189`, redirect check `:183`; **does not branch on `trusted`
  today** — the wiring point) + `:223+` (token exchange) + `:409-490` (device
  grant, RFC 8628, fully implemented — reserved for future cross-device sign-in,
  §4.5),
  `packages/api-contract/src/contracts/oauth.ts:36-44` (the authorize route is
  `method:'post'`, `bearerAuth` — confirming the ASWAS page is the *web*
  `authorization_endpoint`, not this JSON route, §4.1),
  `packages/api/src/models/oauth-refresh-token.ts:7-26,120-146` (rotation +
  reuse-detection + `revokeChain` — the credential is individually revocable, so
  logout is a real server-side kill switch and refresh MUST single-flight, §4.2),
  `packages/web/src/app/(auth)/oauth/authorize/page.tsx` (`'use client'` — POSTs
  `apiClientV2.oauth.authorize.$post` then navigates to `redirectUri`; renders
  `ConsentCard` today; §4.4 adds the trusted-client auto-submit — the WEB half of
  the companion change),
  `packages/api/src/hono/handlers/tokenAuth.ts:75-130` (the password-login path
  the app does **not** use — note it runs **no** brute-force throttle) +
  `packages/api/src/hono/middleware/rate-limit.ts` (rate limiter wired only to
  autocomplete / attachment-upload, not login — §13/§14 host-responsibility note),
  `packages/api/src/models/user.ts:99-104` (legacy v1 `googleId`/`githubId`
  third-party-id methods — vestigial; v2 has no in-app social/SSO, and OAuth's
  host login page covers any RFC-0014 provider anyway, §4.5),
  `packages/api-contract/src/schemas/app.ts:13-15,39-46`
  (`AppInfoResponseSchema` — `version`/`apiVersion`/`capabilities` are
  **required** (no `.optional()`), so a `capabilities`-omitting host hard-fails a
  *strict* decode → the add-probe + refreshes MUST decode `/app/info` leniently
  and fall back to the static baseline, §3 step 2 / §5.2; plus `confidential` and
  its always-on-banner contract comment),
  `packages/api/src/hono/handlers/app.ts:52-56` (operator `app:confidential`
  notice → `/app/info.confidential`, §6.3),
  `packages/api-contract/src/schemas/app-capabilities.ts:28-41,48`
  (`STATIC_CAPABILITIES` incl. `pat`; `API_SURFACE_VERSION = 'v2'` — the binary
  `apiVersion`, so graduated skew keys on `version`, §5.2),
  `packages/api/src/hono/handlers/app.ts:33-41` (runtime `search`/`collab`
  capability append),
  `packages/api/src/hono/handlers/search.ts:57,83` (`503 feature:'search'`
  gating),
  `packages/api-contract/src/schemas/page.ts:89,97-99,100,105,129,288,323,404-409`
  (`Revision.body` / `renderedAst` / `rendererVersion`; `PageSchema.revision` is
  `string | RevisionSchema` and **list endpoints emit a bare string id with no
  body** — only detail emits `body`/`renderedAst`, so the editor must detail-GET
  before edit, §8; `PUT /pages` `revision_id`; `PageRevisionErrorSchema`),
  `packages/api/src/hono/handlers/page.ts:185-199` (detail handler populates
  `body`/`renderedAst` only on the detail path) + `:517`
  (`pageData.isUpdatable(revision_id)` compares the submitted id against the
  page's **current latest** revision — the lock source must be the detail
  revision, not a stale list string, §8),
  `packages/api-contract/src/contracts/page.ts:148,262,322,353,384` (children /
  seen / like / unlike / watch),
  `packages/api/src/hono/handlers/page.ts:446-499` (`POST /pages` create — the
  four `400` failure modes the §8 quick-create UX handles: `INVALID_GRANT`
  `:452`, `PAGE_EXISTS` `:459`, `PAGE_TWIN_EXISTS` `:468`, `NON_EXISTENT_USER_PAGE`
  `:488`, plus the not-granted→`PAGE_EXISTS` collapse `:492-495`),
  `packages/api-contract/src/contracts/me.ts:5-10` (`/me`,
  `/me/recently-viewed-pages`),
  `packages/api-contract/src/schemas/attachment.ts:10,32` (relative
  `/api/v2/attachments/<id>` URL),
  `packages/api-contract/src/schemas/user.ts:41` (`UserSchema.image` — the
  avatar URL) served by `GET /attachments/by-key/<key>`, which is **Bearer-gated
  + `user/`-prefix-restricted but NOT page-grant-checked** (handler
  `packages/api/src/hono/handlers/attachment-stream.ts:128-161`; `createJwtAuth`
  `:120`, prefix check `:44-45,:141-143`; no `loadGrantedPage`) — the second
  auth-gated image shape the loader must cover, and the asymmetry vs. the
  grant-checked embedded path, §6.1,
  `packages/api/src/hono/handlers/attachment-stream.ts:173-228` (the
  authenticated, page-grant-checked image byte stream — grant check `:198`,
  byte stream `:221-228`; no public/CDN URL, §6.1) +
  `:53,:224-225` (`inline` `Content-Type` from the stored `fileFormat`; **SVG is
  an accepted, un-sanitized type** → attachment bytes are raster-decoded only,
  never a web/SVG-DOM context, §6.1/§14),
  `packages/api/src/hono/middleware/cors.ts:1-15` (no-`Origin` allowed —
  mobile),
  `packages/api/src/hono/handlers/oauth.ts:172,206` (the app's requested scopes
  are granted on the authorization code up front, so the OAuth access token is
  correctly scoped and v1 never hits `403 INSUFFICIENT_SCOPE`, §4.2),
  `packages/web/src/components/editor/render-mdast.ts:166` (web renderer uses
  `allowDangerousHtml: true`, **no `rehype-sanitize`** — the untrusted-body basis
  for §6.1/§6.2),
  `packages/api-contract/src/schemas/collab.ts:50,62` (the 5-min `wsToken` the
  app avoids),
  `packages/api/src/notifications/attach.ts` (the optional WS "changed" signal),
  `packages/api-contract/src/contracts/notification.ts:165-173`
  (`GET /notifications/token` — mints the WS auth token) +
  `packages/api/src/util/notifications-token.ts:24-32`
  (`NOTIFICATIONS_TOKEN_TTL_SECONDS = 60` — the 60-second TTL that forces the
  proactive re-mint of §11),
  `packages/api-contract/openapi.json` (the generation input),
  `pnpm-workspace.yaml` (the `apps/*` glob driving the §10 build carve-out),
  `biome.json:10` + `lefthook.yml:7,13` (the filesystem/staged-file globs that
  reach JS/TS files in `apps/apple/` independently of `package.json` — §10, OQ-5).
- RFCs: RFC-0012 (the multi-profile CLI this app mirrors — incl. its OAuth
  Auth-Code + PKCE sign-in and discovery resolution, the model for §4; the app
  diverges only in the redirect transport — ASWAS + custom scheme vs. the CLI's
  loopback listener), RFC-0011 (MCP — sibling `/api/v2` consumer), RFC-0010
  (OAuth 2.0 & Scoped API Access — **the substrate v1 auth is built on**:
  Auth-Code + PKCE, RFC 8414 discovery, redirect validation, rotating/reuse-detected
  refresh token, scoped access tokens; v1 adds a `trusted` `crowi-ios` client +
  custom-scheme redirect, §4),
  RFC-0014 (auth provider plugins — inbound SSO/social for the **host's** login
  page, which the OAuth webview covers with no app change, §4.5),
  RFC-0003 (realtime collab — avoided), RFC-0009 (revision storage),
  RFC-0015 (image display attributes — a renderer extension honored later, OQ-1 in §16).
- External: [swift-openapi-generator](https://github.com/apple/swift-openapi-generator)
  (3.1-spec generation is the §5.1 / OQ-7 GO/NO-GO),
  the candidate Markdown renderers
  [swift-markdown-ui / MarkdownUI](https://github.com/gonzalezreal/swift-markdown-ui)
  (now in **maintenance mode**) and its actively-developed **Textual** fork — the
  renderer is chosen by the §5.1 / OQ-10 spike (image-provider seam +
  redirect-hook + image-node bypass + extension coverage), not pre-locked;
  `ASWebAuthenticationSession` (the OAuth webview + `callbackURLScheme` capture,
  §4) / `CFBundleURLTypes` (declaring the `crowi-ios://` scheme) / SwiftData /
  Keychain Services (Apple platform frameworks); RFC 8414 (OAuth server metadata
  discovery, §4.1), RFC 8252 (OAuth for native apps — custom-scheme/loopback
  redirects), and RFC 8628 (device grant, the reserved cross-device flow, §4.5).
  Prior art for multi-account native clients: Slack, Mastodon (iOS) —
  workspace/account isolation + per-account push routing.
