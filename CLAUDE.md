# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Crowi is a Markdown-based Wiki application for team knowledge sharing. The
codebase is mid-migration from a legacy Express + Swig + jQuery monolith to a
modern Hono API plus a Next.js 16 (App Router) frontend.

**Current Status (Crowi 2.0)**: Turborepo monorepo with two apps and one
shared contract package. Most core wiki features (page CRUD / list / portal /
revisions / bookmarks / likes / seen-by / comments / watch / trash / backlinks
/ notifications / user pages / page history) have been migrated to the new
stack. Admin section is in progress (foundations + crypto migration UI +
security settings landed). See `TODO.md` for the up-to-date phase status.

## Monorepo Structure

```
crowi/
├── apps/crowi-runner/        # reference runner project (@crowi/runner-app): dev
│                             #   launch point + full Docker image build source.
│                             #   Owns @crowi/api + full plugin set + crowi.config.json.
├── apps/crowi-site/          # crowi.wiki LP + docs (Next.js + Fumadocs, :4303)
├── .env(.example)            # dev runtime env at repo root. dev loads it via the
│                             #   api `dev` script's `--env-file-if-exists=../../.env`
│                             #   (cwd is apps/crowi-runner); prod/operators rely on
│                             #   app.ts `dotenv.config()` reading the cwd's .env.
└── packages/
    ├── api/                  # Hono API (:4301)
    ├── api-contract/         # Hono (@hono/zod-openapi) contracts + Zod schemas
    ├── web/                  # Next.js 16 App Router (:4302)
    ├── runner/               # config loader + plugin resolver (used by api boot)
    ├── tsconfig/             # shared library/app-node/app-web tsconfig presets
    ├── admin-cli/            # `crowi-admin` CLI
    └── plugin-{api,aws,storage-*,renderer-*,search-elasticsearch}/
```

`ls packages/` and `tree -L 2 packages/api/src` give the rest. Highlights
worth knowing without reading code:

- `packages/api/src/hono/` — the Hono app: `handlers/` (endpoint handlers; `handlers/admin/` for admin), `middleware/`, `app.ts`
- `packages/api/src/crowi/index.ts` — boot sequence (encryption → DB → config → plugins → server)
- Plugin resolution: `@crowi/runner` reads `crowi.config.json` + uses
  `createRequire(<projectDir>/package.json)` to load plugin npm packages from
  the runner's `node_modules/`. Operators add a plugin by declaring it in
  their runner's deps + listing in `crowi.config.json:plugins`; the api never
  needs to be rebuilt. Dev path: `projectDir` = `apps/crowi-runner` (the
  monorepo's reference runner project `@crowi/runner-app`, which owns
  `@crowi/api` + the full plugin set + `crowi.config.json`); the api `dev`
  script `cd`s there before `tsx watch`, so dev resolves plugins exactly the
  way prod does. The full Docker image (`packages/api/Dockerfile`) is built by
  `pnpm deploy --filter=@crowi/runner-app`. `@crowi/api` itself is plugin-free
  (SDK `@crowi/plugin-api` + core only). `.npmrc` still hoists `@crowi/plugin-*`
  to the repo root for now.

## Tech Stack

- **API**: Hono 4 + `@hono/zod-openapi` + Mongoose + JWT auth (`jwtAuth` middleware)
- **Web**: Next.js 16 (App Router, Turbopack) + React 19 + Tailwind CSS v4 + shadcn/ui + @tanstack/react-query
- **Shared**: TypeScript 5.x strict, pnpm workspaces, Turborepo
- **Format / Lint**: Biome (format) + ESLint (lint), lefthook hooks
- **Tests**: Jest + supertest + mongodb-memory-server (API only; web tests TBD)

## Development Commands

Scripts live in root + per-package `package.json`. `pnpm <script>` filters with
`turbo` automatically. Non-obvious points:

- **Dev**: `docker compose up -d` for infra (mongo/redis/es/plantuml) →
  `pnpm dev` for api+web+plugins. `pnpm dev:api` / `pnpm dev:web` for one side.
- **Targeted run**: `pnpm --filter @crowi/api <script>` to run a script in
  one package only.
- **Lint must be errors=0** (warnings tolerated). pre-push lefthook enforces.
- **Format**: Biome auto-runs on staged files (lefthook pre-commit). `pnpm
  format` only when bypassing hooks.
- **api-contract**: edit contracts/schemas → `pnpm --filter @crowi/api-contract
  build` to regenerate dts before api/web consumers pick them up (turbo `^build`
  handles this in `dev` / `build` / `test`).
- **OpenAPI artifacts (run before committing any API change)**: after editing contracts/schemas or routes, run `pnpm check:openapi`. It regenerates `packages/api-contract/openapi.{json,yaml}` and `src/generated/openapi.ts` from the contracts and fails if the committed copies drifted, leaving the regenerated files in the working tree — `git add` them into the same commit. The pre-push hook runs this too (scoped to `packages/api-contract/**`), so a stale spec blocks the push.
- **Realtime collab dev**: `pnpm dev` is enough — `@crowi/collab` is attached
  as a library inside the api process (RFC-0003 §"Implementation notes"), so
  there is no separate collab process / port to manage. To smoke-test collab
  locally, run `/crowi-qa <target> --charters 2` (the 2-window collab charter —
  see `.claude/skills/crowi-qa/SKILL.md` §2 for the charter table and §11 for
  the 2-window isolation constraint) instead of driving the browser by hand.

## Architecture Overview

### API server (`packages/api`)
- **Boot**: `Crowi.init()` runs `setupEncryption` → `setupDatabase` → `setupModels` → `setupRedisClient` → `setupSessionConfig` → `setupConfig` → `setupSearcher` → `setupMailer` → `setupSlack` → `buildServer`.
- **Routing** (all Hono, mounted under `/api/v2`):
  - Public routes (no auth)
  - Authenticated routes under `createJwtAuth(crowi)` (most page / user / comment / etc. endpoints)
  - Admin routes under `createJwtAdminRequired(crowi)` (= JWT + `user.admin === true`)
- **Auth**: JWT (access + refresh tokens). `req.user` is augmented to `UserDocument` via `packages/api/src/types/express.ts`.
- **Models** (Mongoose):
  - Page (with grant), Revision, User, Comment, Bookmark, Like (on Page), Watcher, Notification, Activity, Config, Backlink, Share, Attachment.
- **Sensitive Config encryption**: `packages/api/src/util/crypto.ts` provides AES-256-GCM `encrypt` / `decrypt` / `isEncrypted`. Sensitive keys are registered in `models/config-sensitive.ts`: a static set for the few that remain in core config (OAuth secrets, Slack token) plus a runtime set that each plugin's `@sensitive` config fields (storage / mail credentials etc.) register at boot. They are auto-encrypted by `Config.updateByParams` / decrypted by `Config.loadAllConfig` when `CROWI_ENCRYPTION_KEY` is set. Legacy plaintext rows pass through; admin can re-encrypt them via `/admin/crypto/reencrypt`.
- **Realtime collab (RFC-0003)**: Hocuspocus is attached to the api process as a library via `packages/api/src/collab/attach.ts`, using the api's `http.Server` in `ws noServer` mode for `/collab/*` upgrades. When `crowi.redis !== null` (i.e. `REDIS_URL` is set), `@hocuspocus/extension-redis` is auto-attached so multi-instance deployments work without sticky sessions. See `docs/rfcs/0003-realtime-collaborative-editing.md` for the design and `apps/crowi-site/content/docs/{ja,en}/operations/realtime-collab.mdx` for operator instructions.

### Web frontend (`packages/web`)
- **Routing**: App Router (`src/app/...`) with three Route Groups:
  - `(public)/`: login / register / installer
  - `(auth)/`: gated by `useAuth` redirect; mounts shared header (NotificationBell + admin shortcut + user dropdown)
  - `(admin)/`: gated by `user.admin === true`; renders sidebar + breadcrumb. Non-admin sees `AccessDeniedCard`.
- **Data fetching**: `@tanstack/react-query` everywhere. `apiClientV2` (a `hc<AppType>` Hono RPC client) is created from the shared `AppType`. Hooks live in `src/lib/use-*.ts`. Convention: `xxxKeys = { all, detail(id) }` query-key factories; mutations invalidate or `setQueryData` on success.
- **Shared UI**: `components/ui/` (shadcn) + cross-cutting primitives `LoadingSpinner` / `ErrorAlert` / `AccessDeniedCard` / `NotFoundCard`.
- **Auth state**: `useAuth` (JWT in client cookie / context).

### API Contracts (`packages/api-contract`)
- All API contracts and Zod schemas live here, built with tsup (CJS + ESM + .d.ts).
- Contracts are `@hono/zod-openapi` `createRoute(...)` route definitions, grouped per namespace (`page`, `user`, `bookmark`, `notification`, `admin`, `adminCrypto`, ...). `client.ts` composes them into the exported `AppType` (split into several `OpenAPIHono` chains, intersected — see the TS2589 note there).
- Common error schemas in `schemas/common.ts`: `AuthenticationRequiredError`, `AdminRequiredError`, `UserStatusError`, etc. Middlewares return these as JSON instead of redirecting.
- Build after editing: `pnpm --filter @crowi/api-contract build` (turbo pipeline auto-runs `^build` for `dev`, but standalone scripts may need it manually).

## Key Environment Variables

See `.env.example` at the repo root. In dev the api `dev` script loads this
repo-root `.env` explicitly (`tsx ... --env-file-if-exists=../../.env`) because
it runs with cwd = `apps/crowi-runner` (the projectDir). In prod / for external
operators the api's `dotenv.config()` reads the `.env` in the process cwd (the
runner project dir); the Docker image gets these from the container env instead.
Required / commonly-set:
- `MONGO_URI` — MongoDB connection
- `REDIS_URL` — session / socket.io adapter + realtime-collab pub/sub
  (`@hocuspocus/extension-redis`) + per-page editor cap counter. **Required
  for multi-instance api deployments**; optional in single-instance dev.
- `PASSWORD_SEED` — legacy password hashing seed (still used for fallback verification)
- `CLIENT_URL` — used for CORS in production (defaults allow localhost in dev)
- `CROWI_ENCRYPTION_KEY` — base64-encoded 32-byte AES-256 key for sensitive Config
  encryption. Generate with `openssl rand -base64 32` or
  `pnpm --filter @crowi/api crypto:gen-key`. Optional but strongly recommended;
  when missing, sensitive values are stored as plaintext (legacy mode) and a
  warning is logged on boot.
- `WS_TOKEN_SECRET` — HMAC signing key for the short-lived wsToken (JWT) used
  to authenticate Hocuspocus WebSocket upgrades. **Must be identical across all
  api replicas** in multi-instance deployments — a token minted on replica A
  may be verified on replica B, and a mismatch leaves clients unable to
  connect. If unset, a random secret is generated per process and a warning is
  logged (acceptable only for single-instance development).
- `COLLAB_MAX_EDITORS_PER_PAGE` — per-page simultaneous-editor cap (default
  `20`). The 21st editor and beyond receive read-only realtime updates.
- `NEXT_PUBLIC_COLLAB_URL` — optional. The WebSocket URL the browser dials.
  When unset, the web app derives it from `window.location.host` and
  `NEXT_PUBLIC_API_URL`, so leave it blank if `/collab/*` is reverse-proxied
  to the same host as the api.

Search backend connection settings (Elasticsearch / OpenSearch URL, index
name, analyzer, etc.) live in the plugin Config namespace and are edited
from the admin UI (`/admin/plugins`). No env variable.

Storage backend selection moved from a `FILE_UPLOAD` env to the
runner's `crowi.config.json` (`storage.driver: 'local' | 's3' | …`)
plus the matching `@crowi/plugin-storage-*` package being installed
in the runner.

## TypeScript Guidelines

- No new `any`. When touching code that has `any`, replace incrementally with a proper type.
- Don't sweep unrelated code in the same change — keep the diff focused.
- Prefer `Pick<>` / `Omit<>` over re-typing fields.
- Mongoose document types: import `XxxDocument` from `models/xxx.ts`.

## Crowi 2.0 Migration Strategy

The migration is feature-by-feature: a legacy Express controller + Swig view
gets re-implemented as a Hono handler + Next.js page. The legacy Express /
ts-rest layers have since been fully removed (RFC-0006).

- Don't touch unrelated legacy code in a migration commit.
- New code goes under `hono/handlers/`, `(auth)/` / `(admin)/`, `lib/`,
  `components/`.

Detailed phase status lives in `TODO.md`.

## Operational Conventions

### main-direct commit strategy
- All work commits to **main directly**. No PR / no per-feature branch by default.
- `git push` waits for explicit user instruction (see `~/.claude/CLAUDE.md`).
- Origin is on GitHub but pushes are intentional. Do not create branches /
  PRs unless asked.

### Parallel worktree workflow
- Long features run in a `gw start <name>` worktree at `crowi-<name>/`.
  Multiple worktrees can run concurrently (e.g. backlink, admin-security,
  refactor-comment).
- When a worktree is done, run `/integrate-worktree <name>` from the main
  worktree. The skill: merges into main → resolves conflicts → runs
  `pnpm test / type-check / lint` → closes the worktree (`gw end`) →
  optionally closes the matching tmux window → invokes `simplify` to clean
  the merged diff.
- Never use `git worktree add/remove` directly — use the `gw` wrapper.

### Parallel worktree dev ports + dev portal + tailscale (mobile verification)
`pnpm dev` auto-detects the worktree and assigns each one a deterministic
4-port block (stride 10): `api = anchor`, `web = anchor+1`, `site = anchor+2`,
`proxy = anchor+3`. `main` is pinned to `anchor 4301` (today's ports, no
migration); every other worktree gets the next free block starting at 4310,
recorded in `~/.crowi-dev-ports.json` (outside the repo, shared across every
worktree checkout) so the same worktree always gets the same anchor. Pin one
explicitly with `pnpm dev --anchor 4350`. **Fixed-port tooling must stay outside
this `4300-4999` band** or it clashes with a worktree's block — e.g. the e2e
servers sit just below at `4290`/`4291` (`packages/e2e/src/config.ts`).

- **The proxy (`anchor+3`) is the canonical dev entry point**, not the raw web
  port. `pnpm dev` fronts api + web + the collab/presence/notifications
  WebSocket namespaces behind one same-origin reverse proxy (Caddy if
  installed, otherwise a zero-dep node fallback — see `scripts/dev-caddy.mjs`),
  the same routing table as the prod front proxy (`Caddyfile`). This is what
  lets realtime editing work at all: Next's `rewrites()` is HTTP-only and
  can't forward a WS `upgrade`, so opening the web port directly skips the
  proxy and collab/presence/notifications won't connect (see the doc comment
  in `packages/web/src/lib/resolve-ws-url.ts`).
- **tailscale serve** publishes only the proxy port (`tailscale serve --bg
  --https=<anchor+3> localhost:<anchor+3>`) so an iPhone/other Mac on the same
  tailnet can open `https://<your-machine>.<tailnet>.ts.net:<anchor+3>` and get
  full realtime editing without restarting `pnpm dev`. Requires tailnet
  HTTPS/MagicDNS enabled; missing/not-logged-in `tailscale` just warns and
  continues (localhost still works). Ctrl-C / closing a worktree only turns
  off *that* worktree's serve (`--https=<anchor+3> off` — never `tailscale
  serve reset`, which would also drop every other worktree's proxy).
- **The dev portal** is a read-only dashboard on a fixed `:4300` listing every
  live worktree (from `git worktree list`) with its up/down status (proxy port
  probe), reachable proxy URLs (localhost + this host's LAN/tailscale IPs + the
  tailscale MagicDNS URL, rendered as a mobile-friendly card layout), and DB
  (shared vs. isolated). It's a separate long-lived process so restarting one
  worktree doesn't take the portal down for the others, and self-GCs registry
  entries for worktrees that no longer exist. **The main worktree's `pnpm dev`
  auto-starts it** (main is the always-around home base; feature worktrees rely
  on main's). Run it standalone with `pnpm dev:portal`, or opt main out with
  `CROWI_DEV_NO_PORTAL=1`. Both the portal and each worktree's proxy bind
  `0.0.0.0`, so they're reachable by IP (`http://<ip>:4300` /
  `http://<ip>:<anchor+3>`) from a phone on the tailnet or LAN even without the
  `tailscale` CLI (dev-only; also LAN-exposed, an accepted tradeoff).
- **DB isolation is opt-in and mongo-only** (redis/ES always stay shared —
  redis's URL parser ignores the db-number path segment, and both are
  ephemeral state). Add `dev.local.json` at the worktree root (gitignored):
  `{ "isolateDb": true }`, or pass `--isolate-db`; the mongo DB name becomes
  `crowi_<key>` instead of the shared one. `pnpm migrate apply` (the only
  destructive migrate subcommand — `--dry-run`/`plan`/`status` are exempt)
  refuses to run from a non-main worktree against the shared DB unless you
  isolate it, pass `--yes`, or set `CROWI_MIGRATE_FORCE=1` (non-interactive
  environments fail closed instead of hanging on a prompt).
- Implementation lives in `scripts/dev-ports.mjs` (registry/lock/key
  normalization), `scripts/dev-caddy.mjs` (proxy config generation + fallback),
  `scripts/dev-portal/` (the dashboard), and the `scripts/dev.mjs` /
  `scripts/migrate.mjs` extensions that wire them together.

### simplify after merge
After merging a worktree, the integrate-worktree skill spawns 3 review agents
(reuse / quality / efficiency) over the merge diff. Every finding is either
**fixed on the spot** (a `refactor(merge): ...` commit) or **dropped**.

### Review findings: fix or drop (applies everywhere)
Review / simplify / QA findings are NEVER parked in `TODO.md` or any backlog.
The only two outcomes are: fix it now, or drop it (report the drop in one
line). This applies to every skill and agent (feature pipeline, crowi-review,
integrate-worktree, orchestrate C, crowi-fix, future skills). `TODO.md` is for
roadmap items and blocked dependency majors only — not a review-advisory
graveyard.

### Hooks (lefthook)
- **pre-commit**: Biome format on staged files
- **pre-push**: `pnpm lint` (errors=0 required) + `pnpm check:openapi` (only when `packages/api-contract/**` changed — the OpenAPI artifacts must be regenerated and committed)
- Installed during `pnpm install`.

### Commit messages
- **Always write commit messages in English** (subject + body), even when
  the working conversation is in Japanese.
- Conventional Commits: `feat(api): ...`, `feat(web): ...`,
  `feat(api-contract): ...`, `fix(...)`, `refactor(...)`, `chore(...)`,
  `docs(todo): ...`.
- Multi-paragraph body explaining WHY when the change isn't obvious.

### Changesets (release notes accumulation)

`@changesets/cli` is set up (Phase 9). Throughout v2 development, accumulate a `.changeset/*.md` per release-worthy change with `pnpm changeset add`, so the release notes for 2.0.0-alpha1 / stable are generated automatically from the past changes.

Write changeset bodies in English too (like commit messages, they go straight into the release notes), even when the working conversation is in Japanese.

When to add — one changeset per "unit of user value":
- ✅ Feature / bug fix / breaking change → one changeset.
- ✅ One feature split across several commits is still one changeset if it's a single thing from the user's point of view (do not add a changeset per small in-progress commit).
- ❌ Internal refactor / cleanup / lint fix / format / build infra / tests only → no changeset (no user-visible change).
- ❌ docs(todo) / CLAUDE.md / `.claude/` updates → no changeset.
- ❌ Per-phase commits of `feature-monorepo-packages-restructure` → covered as a whole by one changeset (`.changeset/initial-release.md`).

Rule of thumb: "is it worth writing in the next changelog?" Add when `feat:` / `fix:` changes user behavior; skip when it is only `refactor:` / `chore:` / `test:` / `docs:`.

Choosing the bump level:
- `patch` — bug fix, an internal optimization that becomes observable, dependency bump (semver-safe).
- `minor` — new feature, new endpoint, backward-compatible config addition.
- `major` — breaking change (API removal, endpoint contract change, newly-required config).

Choosing the target package:
- Changed API behavior → `@crowi/api`.
- Changed Web UI → `@crowi/web` (private, so it is never published, but a CHANGELOG.md is still generated).
- Changed an API contract → `@crowi/api-contract` (linked group, so api / web bump together).
- Extended the plugin SDK → `@crowi/plugin-api` + the affected individual plugins.
- Updated a single plugin → that plugin only.

Commands:
```bash
pnpm changeset add        # interactively pick package + bump level + summary
pnpm changeset status     # list accumulated, unreleased changesets
```

Add one file just before merging to main (or within the PR). The initial `.changeset/initial-release.md` is a sentinel covering the whole restructure, placed when `feature-monorepo-packages-restructure` completed — do not delete it.

### State directories
- `.reviews/` (gitignored): per-skill review notes; not committed.

## Slash Commands / Skills

User-invocable skills (see `.claude/skills/`):
- **`/integrate-worktree <name>`** — merges a `gw` worktree into main and
  runs simplify. See "Parallel worktree workflow" above.
- **`/simplify <description>`** — 3-agent reuse / quality / efficiency review
  over recent changes; applies low-risk fixes inline.
- **`/crowi-review [scope]`** — Codex adversarial review of a scope (worktree
  diff / main-direct range / area) → Claude neutral verification → report +
  low-risk inline fixes. No PR/merge (main-direct); falls back to Claude
  subagents when `codex exec` is unavailable.

## Crowi Theme

Tokens live in `packages/web/src/app/globals.css` (`--crowi-primary` /
`--crowi-header` / `--crowi-sidebar` etc.). Avatars use `--crowi-primary` as
initials-fallback background (`packages/web/src/components/user-avatar.tsx`).
