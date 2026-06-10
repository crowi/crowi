# RFC-0013: Slack Plugin (integrated) + plugin HTTP routes on Hono

- **Status**: Draft
- **Author**: (you)
- **Created**: 2026-06-06
- **Depends on**:
  - RFC-0001 (Plugin Architecture) — registries (`registerNotifier` /
    `registerAuth`), `@sensitive` / `@action` markers, `adminPlacement`,
    `pageMetadata`, `reconfigure`, transitive load. **This RFC also implements
    the long-reserved `registerRoutes` capability** (RFC-0001 §"registerRoutes"
    + the `plugin-api/src/routes.ts` stub explicitly defer it to "a follow-up
    RFC that wires plugin HTTP contribution onto Hono").
  - RFC-0006 (Hono) — the app the plugin routes mount onto; the public-route
    precedent (`/oauth/*`).
  - RFC-0002 (Renderer Plugin Architecture) — for the **Slack message/thread
    embed** (§7.5): `registerRenderer` / `addEmbedTag` (card embed) + the
    **`AuthContext`** (currently a Phase-7 stub) for the authenticated Slack
    fetch. This RFC's embed capability is the first real consumer of that path.
  - RFC-0004 (Editor UX) — for the editor affordance that offers to convert a
    pasted Slack URL into `@[slack](url)` (§7.5).
- **Related**: RFC-0010 (OAuth — for future *Sign in with Slack*). RFC-0001
  Step 8 (notifier) / Step 10 (auth provider) are realized here for Slack.

## §0 Summary

Add a **single, integrated `@crowi/plugin-slack`** that owns one Slack App and
exposes multiple Slack capabilities. Minimum deliverable: **link unfurling**
(Slack shows a rich preview when a Crowi page URL is posted). Later: a **Slack
message/thread embed** (paste a Slack link into a wiki page → it renders as a
card — the *inverse* of unfurl), **slash commands** (e.g. turn a thread into a
wiki page) and **notifications**; and, much later, *Sign in with Slack*.

The embed would be Crowi's **first real "URL card" renderer extension**: the
renderer SDK already ships the card mechanism (`addEmbedTag` with a `card`
reservation + cache/SWR), but has no real consumer yet (GitHub Embed is planned
but stubbed), and its `AuthContext` (for authenticated fetches) is a Phase-7
stub — which this capability implements.

To receive Slack's inbound webhooks (events / slash / interactivity), the
plugin SDK needs HTTP routes — currently a **no-op stub**. So this RFC's
**Phase 0** implements `registerRoutes` on Hono (mount under
`/api/v2/plugins/<name>/*`, with public + raw-body support for signature
verification). This is reusable by any inbound/OAuth-callback plugin.

Architecture decision (§3): **one vendor-integrated plugin**, not an AWS-style
base+consumer split and not a "messaging platform" abstraction. Vendor-generic
capabilities (notify, auth) are exposed through the **existing registries**
(`NotifierRegistry` / `AuthRegistry`); Slack-specific, open-ended features
(unfurl, slash) live directly in the plugin against its one inbound endpoint.

## §1 Background / Motivation

- We want Crowi page links posted in Slack to **unfurl** (rich preview). Later,
  **slash commands** for stock-ifying flow (e.g. "save this thread as a wiki
  page") and page-related **notifications**. Page-update notification *UX* is
  deliberately deferred (no good design yet).
- The user-facing **setup flow** is: enable the plugin → from the admin
  settings, **generate a Slack App manifest** → create the Slack App from it →
  install to the workspace → paste the bot token + signing secret into admin →
  it works.
- Investigation found the substrate is mostly present:
  - Registries `registerNotifier` (`NotifierDriver { send(payload) }`) and
    `registerAuth` are **wired**; core already fans notifications out to notifier
    plugins (`forwardToNotifierPlugins()` in `models/notification.ts`).
  - `@sensitive` (encrypted config) + `@action` (admin buttons →
    `/api/v2/plugins/<name>/<path>`) + `pageMetadata` (per-page channel) are
    implemented.
  - Legacy `packages/api/src/util/slack.ts.reference` has working WebClient /
    OAuth / `chat.postMessage` / mrkdwn / diff / **unfurl** builders to port.
  - **Gap**: `registerRoutes` is a no-op stub → no inbound endpoint, no
    signature verification. **Even the minimum (unfurl) needs it.**

## §2 Goals / Non-Goals

### §2.1 Goals

- **Phase 0**: `registerRoutes(scope, ctx)` on Hono — plugins mount handlers at
  `/api/v2/plugins/<name>/*`, optionally **public** (bypass `createJwtAuth`,
  for Slack-signed endpoints) with **raw-body** access (for HMAC verification).
- **Phase 1 (minimum)**: `@crowi/plugin-slack` owning the Slack App
  (config + manifest), an inbound events endpoint with Slack signature
  verification + `url_verification` handshake, and **unfurl** of Crowi page
  links (`link_shared` → `chat.unfurl`).
- One Slack App, one inbound surface, multiple capabilities — integrated.
- Reuse registries for the generic bits (notifier now-ready, auth later).

### §2.2 Non-Goals

- **Page-update notification UX** — infra (notifier) is ready, but the *what/
  when/where* UX is deferred (explicit user decision).
- **AWS-style base + consumer packages** for Slack (§3 explains why not).
- **"Messaging platform" abstraction** (Slack/Discord) — premature (§3).
- **Sign in with Slack** — future (post-alpha1; `registerAuth`), §7.4.
- **Socket Mode** — use HTTP Events API (a public URL), not Socket Mode.
- **Multi-workspace** in v1 — one workspace per instance to start.

## §3 Architecture decision: one integrated Slack plugin

The shared resource is **one Slack App** = bot token + signing secret + **one
inbound endpoint** (events / slash / interactivity all arrive there, all
verified by the same signing secret) + one manifest. Three options were
weighed:

- **(A) AWS-style base + consumers** (`@crowi/plugin-slack` config-only base +
  `slack-notifier` / `slack-auth` packages). The AWS pattern fits **storage /
  mail** because those are separate packages sharing **pure credentials**, each
  a clean single-registry consumer. Slack's shared part is **behavior + a single
  inbound endpoint**, not just config; and **unfurl / slash don't fit a
  "consumer registers a driver" model** at all. Splitting fragments the one
  endpoint/signing and pushes heavy behavior into the "base". → **Rejected.**
- **(B) "Messaging platform" abstraction** (Slack + Discord). Only two plausible
  vendors, and slash/unfurl/interactivity don't generalize. Premature, bad
  abstraction. → **Rejected.**
- **(C) One integrated `@crowi/plugin-slack`** that owns the Slack App and
  hosts all Slack features, **implementing the existing generic registries**
  (`NotifierRegistry`, later `AuthRegistry`) so core (notification fan-out,
  future social login) uses Slack through the standard interface, while
  Slack-specific features (unfurl, slash) live directly in the plugin. →
  **Chosen.**

**Key principle**: the cross-vendor abstraction is the **registry**
(`NotifierRegistry` / `AuthRegistry`), *not* a "Slack base config" package. The
shared Slack-App config is owned **inside** the one plugin (no separate base
package needed, unlike AWS, because no *other* package needs Slack creds). If a
second messaging vendor ever appears, it implements the same registries — the
abstraction point already exists.

## §4 Phase 0 — `registerRoutes` on Hono (SDK prerequisite)

`packages/plugin-api/src/routes.ts` is a deliberate no-op stub awaiting "a
follow-up RFC that wires plugin HTTP contribution onto Hono". This is it.

- **Surface**: `registerRoutes(scope, ctx)` where
  ```ts
  interface PluginRouterScope {
    // Mount a Hono handler at /api/v2/plugins/<plugin-name>/<path>.
    route(method: 'GET'|'POST'|..., path: string,
          handler: (c: Context) => Response | Promise<Response>,
          opts?: { public?: boolean }): void;
  }
  ```
- **Mounting**: `PluginManager` builds a per-plugin scope inside `buildHonoApp`
  and registers routes at root-relative `/plugins/<name>/<path>` (the `/api/v2`
  prefix is stripped at the boundary, so they answer at
  `/api/v2/plugins/<name>/...`). Name-segmented → no collision with core or
  other plugins.
- **`public` routes** bypass `createJwtAuth` (mirroring the `/oauth/*` public
  precedent). Slack inbound endpoints are **public to Crowi auth** and
  authenticated solely by the **Slack request signature** (§8). Non-public
  routes (admin test buttons / `@action` targets, OAuth callbacks) keep
  `createJwtAuth`.
- **Raw body**: the handler must reach the **exact raw request body**
  (`c.req.text()` / `c.req.raw`) for HMAC verification — so plugin routes mount
  **before** any body-consuming middleware, or the scope guarantees an
  un-consumed body. This is a hard requirement for Slack.
- **Scope/auth note**: the SDK can later let a route declare a required Crowi
  scope (RFC-0010) for token-authed plugin APIs; v1 only needs `public` vs
  `authed`.
- Wiring this also retroactively enables `@action` endpoints and OAuth
  callbacks for *all* plugins — broadly useful, not Slack-only.

## §5 The Slack plugin — owning the Slack App

`@crowi/plugin-slack`, `adminPlacement: { section: 'notification', label:
'Slack', icon: <allowed lucide> }`.

- **Config** (`configSchema`, all `@sensitive` where secret):
  - `botToken` — `xoxb-…` (`@sensitive`) — for `chat.unfurl` / `chat.postMessage`.
  - `signingSecret` — (`@sensitive`) — verifies inbound requests.
  - (later) `clientId` / `clientSecret` for OAuth install + Sign in with Slack.
- **`@action` "Generate Slack App manifest"** → returns a manifest JSON the
  operator pastes into Slack's "create app from manifest". It embeds:
  - `event_subscriptions.request_url` = `{CLIENT_URL}/api/v2/plugins/@crowi/plugin-slack/events`
  - subscribed bot events: `link_shared` (Phase 1)
  - `unfurl domains` = the instance's wiki host (so Slack sends `link_shared`
    for Crowi links)
  - OAuth scopes: `links:read`, `links:write`, `chat:write` (Phase 1);
    `commands` (Phase 2)
  - (Phase 2) `slash_commands` + `interactivity.request_url`
- **Inbound routes** (Phase 0 `registerRoutes`, `public: true`):
  - `POST /plugins/@crowi/plugin-slack/events` — Events API (unfurl, …)
  - `POST /plugins/@crowi/plugin-slack/slash` — slash commands (Phase 2)
  - `POST /plugins/@crowi/plugin-slack/interactions` — interactivity (Phase 2)
  - each: verify signature → handle `url_verification` challenge → dispatch.
- **Internal dispatcher**: one verification + routing core shared by all inbound
  routes (this is the "shared inbound" that argued against splitting packages).

## §6 Setup flow (mapped to the SDK)

1. Operator adds `@crowi/plugin-slack` to `crowi.config.json` + enables it.
2. Admin → Slack settings → **Generate manifest** (`@action`) → copy JSON.
3. Create the Slack App from the manifest (Slack "from manifest"); install to
   the workspace.
4. Copy the **bot token** + **signing secret** into the admin form
   (`@sensitive` fields, encrypted at rest).
5. `reconfigure` rebuilds the Slack client. Post a Crowi link in Slack →
   unfurls. Done.

## §7 Capabilities

### §7.1 Unfurl (Phase 1 — the minimum)

- Slack sends `link_shared` (Events API) when a Crowi URL is posted in a channel
  the app is in. The endpoint **verifies the signature**, returns `200`
  immediately, then asynchronously calls **`chat.unfurl`** with an unfurl block
  built from the page (title, breadcrumb, excerpt, updated-at) using the bot
  token. Port the builders from `util/slack.ts.reference`.
- **`url_verification`**: on Events API setup Slack POSTs a `challenge`; the
  endpoint echoes it.
- **Retries**: Slack retries on non-2xx/slow; handle idempotently (respond fast,
  do work async).
- ⚠️ **Data-leak guard (§8)**: only unfurl content the channel should see —
  v1 unfurls **public-grant pages** with title+excerpt and, for non-public
  pages, a minimal "🔒 restricted page" card (no body). Full grant-aware unfurl
  needs Slack-user→Crowi-user mapping (§7.2 open problem).

### §7.2 Slash commands (Phase 2)

- e.g. `/crowi save-thread` to stock-ify a Slack thread as a wiki page;
  `/crowi search <q>` returning results.
- Needs the `commands` scope + the `/slash` + `/interactions` endpoints.
- **Identity mapping → explicit account link (decided, §12.2)**: any command
  that *writes as a user* or maps *mentions* requires a real Slack↔Crowi
  identity, so the user must **authenticate / link their account** (Sign in with
  Slack / OAuth, §7.4) — no email-guessing. **Read-only** commands
  (`/crowi search`) run as the bot without per-user identity. Therefore **slash
  *writes* depend on §7.4** (account linking is a Phase-2-write prerequisite).

### §7.3 Notifications (Phase 3 — infra ready, UX deferred)

- `registerNotifier` → Slack `NotifierDriver.send(payload)`; core already calls
  `forwardToNotifierPlugins()`. Per-page channel via `pageMetadataSchema`
  (`{ channel }`) surfaced as `payload.routing`.
- **Page-update notification UX is deferred** (user decision) — ship the driver
  wiring, decide the triggering UX (which events, batching, per-channel rules)
  separately.

### §7.5 Slack message/thread embed — renderer (the inverse of unfurl)

Paste a Slack message/thread link into a wiki page → it renders as a card
(author, text, replies, channel, timestamp). This is the **first real "URL
card" renderer extension** in Crowi.

- **Renderer side (RFC-0002, in the Slack plugin)**: `registerRenderer` →
  **`addEmbedTag('slack', …)`** producing a `card` embed:
  ```ts
  registry.addEmbedTag('slack', {
    cacheVersion: 1,
    reservation: { variant: 'card', size: 'medium' },   // SSR placeholder, no layout shift
    computeEmbedKey: (input) => normalizeSlackUrl(input.url),
    async render(input, ctx) {
      const { botToken } = ctx.auth.config(SlackConfigSchema);  // AuthContext (Phase-7)
      const thread = await fetchSlackConversation(input.url, botToken); // conversations.replies / history
      return { html: renderThreadCard(thread), ttlSec: 3600 };
    },
  });
  ```
  - Uses the **same Slack App bot token** the plugin already owns (so the embed
    capability composes with unfurl/notify — one app, one credential).
  - Reuses the landed **reservation + cache + SWR + error-caching** (network /
    rate-limit / not-found TTLs) and the edit-mode placeholder (no I/O while
    typing).
- **Trigger UX → opt-in `@[slack](url)`, surfaced by an editor affordance**
  (resolves the auto-vs-opt-in tension without changing RFC-0002's "no
  auto-card" policy):
  - The **renderer only acts on `@[slack](url)`** (opt-in) — policy-compliant,
    no bare-URL auto-card.
  - The **editor (RFC-0004)** detects a Slack URL in the buffer and shows a
    small **floating "Embed this Slack thread?" button** near it; clicking it
    rewrites the bare URL to `@[slack](url)`. So pasting *feels* like
    paste-to-embed, but the document stays explicit and the renderer stays
    opt-in.
  - **Generalize where cheap**: ideally the set of "embeddable URL patterns +
    their tag" is **registered by embed plugins** and surfaced to the editor
    (so any future embed plugin gets the same affordance), rather than
    hard-coding Slack in the web editor. A Slack-specific detector is an
    acceptable v1 if the generic registry is more than this milestone warrants.
- **AuthContext prerequisite**: `ctx.auth.config()` is a Phase-7 **stub that
  throws** today. This capability **implements `AuthContext`** (encrypted
  owner-config lookup, RFC-0002 §AuthContext) — the renderer counterpart of the
  `registerRoutes` prerequisite for inbound. Slack is the first real consumer
  (alongside the planned-but-stubbed GitHub Embed).
- **Visibility model (security, §8)**: the embed is fetched with the
  owner-provided bot token, so **"can read the wiki page" ⇒ "can see the
  embedded Slack content"** (same shared-token model as GitHub Embed). Embedding
  a *private* Slack thread into a broadly-readable page leaks it — must be
  surfaced to the user (§8 / §12).
- **Channel access (§12.10)**: Slack only lets the app read channels it can
  access. **Public** channels are **auto-joined** (`conversations.join`) on first
  embed; **private** channels need a human to invite the bot — until then the
  card renders a locked "invite the Crowi bot" placeholder.

### §7.4 Account linking / Sign in with Slack

- `registerAuth` (`AuthRegistry { buttonLabel, iconUrl?, verify }`) +
  `clientId`/`clientSecret` + an OAuth callback route (Phase 0 authed route).
- **Two roles**: (a) optional *social login* (post-alpha1, if login returns —
  RFC-0001 Step 10 / RFC-0010); (b) **the Slack↔Crowi account link that gates
  slash *writes* and mention mapping** (§7.2, §12.2). Role (b) makes this a
  **prerequisite for Phase 2 write commands**, not merely a future nicety.

## §8 Security

- **Slack signature verification** on every inbound request: HMAC-SHA256 over
  `v0:{X-Slack-Request-Timestamp}:{rawBody}` with the signing secret, compared
  (constant-time) to `X-Slack-Signature`; reject if the timestamp is outside a
  ±5-minute window (replay guard). Requires the **raw body** (§4).
- Inbound endpoints are **public to Crowi auth** — authenticated *only* by the
  Slack signature. They must be robust (no Crowi session/token involved).
- Secrets (`botToken`, `signingSecret`) stored `@sensitive` (encrypted at rest
  via the core KeyProvider).
- **Least-privilege scopes** in the manifest (`links:read/write`, `chat:write`;
  add `commands` only when slash ships).
- **Unfurl data leakage** (§7.1): never unfurl restricted page bodies into a
  channel; default to public-only rich unfurl + a locked placeholder otherwise.
- **Embed visibility** (§7.5): a Slack thread embedded in a wiki page is fetched
  with the shared owner bot token, so anyone who can read the page sees it.
  Embedding a *private* Slack thread leaks it to all page readers — warn at
  embed time and/or restrict to channels the bot is in. Mirror of the unfurl
  concern, reversed direction.

## §9 Reuse

| Concern | Reused | How |
|---|---|---|
| Slack client / unfurl / mrkdwn / diff | `util/slack.ts.reference` | port to the plugin (thin `fetch` or `@slack/web-api`) |
| Notification fan-out | `forwardToNotifierPlugins()` + `NotifierRegistry` | `registerNotifier` (Phase 3) |
| Encrypted secrets / admin buttons | `@sensitive` / `@action` + auto-form | token / signing-secret fields + "Generate manifest" |
| Per-page channel | `pageMetadataSchema` + `ctx.pageMetadata` | `{ channel }` → `payload.routing` |
| URL card embed (§7.5) | `addEmbedTag` + `reservation:{variant:'card'}` + cache/SWR/error-TTL (RFC-0002, landed) | `addEmbedTag('slack')`; only `AuthContext` is new (Phase-7 impl) |
| Public-route precedent | `/oauth/*` (no `createJwtAuth`) | the `public` route flag (§4) |
| Plugin load / reconfigure fan-out | PluginManager (RFC-0001) | unchanged |

> **Not** reused: the AWS base+consumer split (§3). The Slack-App config lives
> inside the one plugin.

## §10 Packaging

- New package `packages/plugin-slack` → `@crowi/plugin-slack`, `0.1.0-dev`,
  `publishConfig.access: public`, `requires`/peer `@crowi/plugin-api`.
- **Slack SDK dep — `@slack/web-api`** (§12.4): handles 429 retries +
  `conversations.replies` pagination + typed methods; ESM-only (jiti precedent
  exists). Fall back to thin `fetch` only if weight/ESM bites.
- tsup + app-node tsconfig (same template family as other plugins).
- Phase 0 (`registerRoutes`) is core work in `@crowi/plugin-api` +
  `packages/api/src/plugin/` + `buildHonoApp`, not the plugin package.

## §11 Rollout phases

- **Phase 0** — `registerRoutes` on Hono (public/authed, raw body) + wire in
  PluginManager + `buildHonoApp`. Smoke: a trivial plugin route answers.
- **Phase 1** — `@crowi/plugin-slack`: app config + manifest `@action` +
  `/events` endpoint + signature verify + `url_verification` + **unfurl**.
- **Phase 2** — slash commands + interactivity (`/slash`, `/interactions`) +
  identity mapping; "thread → wiki page".
- **Phase E (Slack→Crowi embed; independent of Phase 0/2)** — implement
  **`AuthContext`** (RFC-0002 Phase 7) + `addEmbedTag('slack')` card renderer +
  the editor affordance that converts a pasted Slack URL to `@[slack](url)`.
  Does **not** need `registerRoutes` (it's outbound fetch, not inbound), so it
  can land in parallel with / before the inbound phases. First real URL-card +
  AuthContext consumer.
- **Phase 3** — `registerNotifier` driver (page-update notification UX TBD).
- **Future** — Sign in with Slack (`registerAuth`).

## §12 Decisions (was open questions)

1. **`registerRoutes` shape — RESOLVED**: a **Hono `Context` handler** +
   `public` flag + **guaranteed raw body**. Rationale: Slack webhooks need
   low-level control (raw body for HMAC, arbitrary headers, odd responses like
   the `url_verification` challenge echo); a typed contract only helps
   *our-UI*-called endpoints (`@action` buttons), which is minor. Typed-route
   sugar + per-route Crowi-scope are deferred.
2. **Identity mapping — RESOLVED: explicit account link (auth) required**.
   Any *write* slash command and any *mention* mapping requires a real
   Slack↔Crowi identity, i.e. the user authenticates / links their account
   (Sign in with Slack / OAuth, §7.4). No email-guessing. Read-only commands
   (`/crowi search`) can run as the bot without per-user identity. → **slash
   *writes* depend on §7.4 (account linking)** — it is elevated from "future
   optional" to a Phase-2-write prerequisite.
3. **Unfurl visibility — RESOLVED**: public pages get rich unfurl; non-public
   pages render a **locked placeholder** (no body).
4. **Slack SDK — RESOLVED: use `@slack/web-api`**. It handles 429 rate-limit
   retries, `conversations.replies` pagination, and typed methods that a thin
   `fetch` would have to reimplement. The only costs (bundle weight, ESM/CJS —
   loaded via runner, jiti precedent exists) are minor. Fall back to thin
   `fetch` only if weight/ESM proves painful.
5. **Manifest base URL — RESOLVED: `CLIENT_URL` is the SSOT** for
   `request_url`. **Dev** needs a public tunnel (ngrok / cloudflared) since
   Slack must reach the endpoint — provide an env override for the manifest's
   request URL in dev. (Open: the exact dev override knob.)
6. **Multi-workspace — RESOLVED: single workspace** in v1.
7. **Notification UX — DEFERRED** (Phase 3): triggers / batching / per-channel
   rules designed separately.
8. **Embed editor affordance — RESOLVED: generic, plugin-registered**. Plugins
   register *embeddable-URL affordances* (URL pattern + floating-action label +
   the conversion/action, e.g. → `@[slack](url)`); the web editor **detects
   matches dynamically and renders the floating button, delegating the action
   to the plugin's declaration** — not Slack-specific code in the editor. This
   is a new editor/plugin-SDK surface (see §7.5). Bigger than Slack, but the
   right shape so every future embed plugin gets the affordance for free.
9. **AuthContext — RESOLVED: implement it in this RFC** (Slack embed is the
   first real consumer). *What it is*: the `RenderContext.auth` handle that lets
   a renderer plugin read its **encrypted owner-config at render time**
   (`ctx.auth.config(SlackConfigSchema).botToken`) to make an authenticated
   external call; today `createAuthContextStub` throws ("Phase 7"). Wiring =
   read the plugin's encrypted config namespace (the store plugins already use)
   and expose it during render; **shared owner-token model** (one token for all
   renders → the §8 "page reader sees the embed" visibility).
10. **Slack URL / API — RESOLVED**: parse `…/archives/<channel>/p<ts>`
    (+ `thread_ts`); `conversations.replies` (thread) / `conversations.history`
    (single message). **Channel access**: Slack *requires* the bot to have
    access — it cannot read a channel it isn't in. Mitigation: **auto-join
    public channels** via `conversations.join` (no human step); **private
    channels need a human invite**, else render a locked "invite the Crowi bot"
    card. ("Works with no bot in the channel" is only achievable for public via
    auto-join.)

### Remaining smaller opens
- Exact dev tunnel override knob (#5).
- The generic embed-affordance SDK surface shape (#8) — how plugins declare the
  pattern + action and how the editor invokes it (API to list rules + apply a
  conversion). Worth its own short design when Phase E starts.

## §13 References

- RFC-0001 (plugin arch; the reserved `registerRoutes`), RFC-0006 (Hono;
  public-route precedent), RFC-0010 (OAuth; future Sign in with Slack),
  RFC-0002 (renderer; the embed-card mechanism + `AuthContext`), RFC-0004
  (editor; the paste-to-`@[slack]` affordance).
- Code: `packages/plugin-api/src/routes.ts` (the no-op stub this RFC replaces),
  `packages/plugin-api/src/renderer.ts` (`addEmbedTag` / `addUrlInlineExpander`
  / `Reservation{variant:'card'}` / `AuthContext`),
  `packages/api/src/renderer/registry.ts` (`createAuthContextStub` — the Phase-7
  throw this capability replaces), `packages/api/src/renderer/core/embed-tags.ts`
  + `…/url-inline-expand.ts` (embed dispatch + cache path),
  `packages/plugin-api/src/registries/notifier.ts` + `…/auth.ts`,
  `packages/api/src/models/notification.ts` (`forwardToNotifierPlugins`),
  `packages/api/src/util/slack.ts.reference` (legacy builders to port),
  `packages/api/src/models/config-sensitive.ts` (`notification:slack:*`),
  `packages/plugin-aws/*` + `packages/plugin-storage-aws-s3/*` (the base+consumer
  pattern deliberately *not* used here), `packages/api/src/hono/index.ts`
  (public `/oauth/*` precedent; where `buildHonoApp` mounts routes).
