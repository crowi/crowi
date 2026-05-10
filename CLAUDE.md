# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Crowi is a Markdown-based Wiki application for team knowledge sharing. The
codebase is mid-migration from a legacy Express + Swig + jQuery monolith to a
modern Express + ts-rest API plus a Next.js 16 (App Router) frontend.

**Current Status (Crowi 2.0)**: Turborepo monorepo with two apps and one
shared contract package. Most core wiki features (page CRUD / list / portal /
revisions / bookmarks / likes / seen-by / comments / watch / trash / backlinks
/ notifications / user pages / page history) have been migrated to the new
stack. Admin section is in progress (foundations + crypto migration UI +
security settings landed). See `TODO.md` for the up-to-date phase status.

## Monorepo Structure

```
crowi/
├── apps/
│   ├── crowi-api/                  # Express + ts-rest API library (port 3300 in dev)
│   │   ├── src/
│   │   │   ├── controllers/        # Legacy Swig-era handlers (still mounted; deprecated)
│   │   │   ├── routes/
│   │   │   │   ├── api/            # Legacy /_api/* endpoints
│   │   │   │   ├── ts-rest/        # ★ New ts-rest handlers (mounted at /api/v2)
│   │   │   │   ├── login.ts        # Legacy auth form routes
│   │   │   │   └── admin.ts        # Legacy admin GET routes
│   │   │   ├── models/             # Mongoose schemas
│   │   │   ├── middlewares/        # jwtAuth / jwtAdminRequired / loginRequired / etc.
│   │   │   ├── service/            # Business logic (search, notifications, config)
│   │   │   ├── events/             # pageEvent / notificationEvent listeners
│   │   │   ├── util/               # crypto, jwt, ts-rest helpers, link detector
│   │   │   ├── plugin/             # PluginManager + registries + config-file loader
│   │   │   ├── types/              # Express Request augmentation
│   │   │   └── crowi/index.ts      # Crowi class (boot, setup, teardown)
│   │   └── .env.sample
│   ├── crowi-dev-runner/           # ★ Local launcher: mirrors a `crowi-admin init` runner repo
│   │   ├── package.json            # deps: @crowi/api + @crowi/plugin-* (decides which plugins are available)
│   │   ├── crowi.config.json       # which plugins to load + active driver names
│   │   ├── .env / .env.sample      # runtime env (CWD-resolved)
│   │   └── nodemon.json            # watches @crowi/api src + plugin dists, runs ../crowi-api/src/app.ts
│   └── crowi-web/                  # Next.js 16 frontend (port 3301)
│       └── src/
│           ├── app/
│           │   ├── (public)/       # Login / register / installer
│           │   ├── (auth)/         # Logged-in pages (page-view, edit, trash, user, ...)
│           │   └── (admin)/        # Admin dashboard + sections (admin-only via layout)
│           ├── components/         # Page, page-view, page-list, admin, ui (shadcn)
│           └── lib/                # React Query hooks, api-client, auth context
└── packages/
    ├── api-contract/               # Shared ts-rest contracts + Zod schemas
    │   └── src/
    │       ├── contracts/          # ts-rest c.router definitions
    │       └── schemas/            # Zod schema definitions
    ├── plugin-api/                 # @crowi/plugin-api — plugin SDK (CrowiPlugin / registries / context)
    ├── plugin-aws/                 # @crowi/plugin-aws — shared AWS credentials base plugin
    ├── plugin-storage-local/       # @crowi/plugin-storage-local — default-on local FS storage driver
    └── plugin-storage-aws-s3/      # @crowi/plugin-storage-aws-s3 — S3 storage driver
```

The api package is plugin-agnostic at runtime — `PluginManager` resolves
plugin npm names against the runner project's `node_modules/` via
`createRequire(<projectDir>/package.json)`. Operators add a plugin by
declaring it in their runner's `package.json` deps and listing it in
`crowi.config.json:plugins`; the api never needs to be rebuilt.

## Tech Stack

- **API**: Express 4 + ts-rest 3 + Mongoose + JWT auth (`jwtAuth` middleware)
- **Web**: Next.js 16 (App Router, Turbopack) + React 19 + Tailwind CSS v4 + shadcn/ui + @tanstack/react-query
- **Shared**: TypeScript 5.x strict, pnpm workspaces, Turborepo
- **Format / Lint**: Biome (format) + ESLint (lint), lefthook hooks
- **Tests**: Jest + supertest + mongodb-memory-server (API only; web tests TBD)

## Development Commands

### Setup and Run
```bash
# Install (root)
pnpm install

# Start dependency services (MongoDB / Redis / Elasticsearch / PlantUML)
docker compose up -d

# Run both apps with auto-reload (dev-runner-mediated api on :3300, web on :3301)
pnpm dev

# Run only the API + plugins through the dev-runner (no Next.js)
pnpm dev:runner

# Run the API directly (no runner mediation; useful for api-only debug)
pnpm dev:api

# Run only the Next.js frontend
pnpm dev:web
```

### Tests / Type-check / Lint
```bash
pnpm test                                    # all apps
pnpm --filter @crowi/api test                # api only
pnpm --filter @crowi/api test -- --testPathPattern=foo

pnpm type-check                              # all apps (api + web)
pnpm --filter @crowi/api type-check
pnpm --filter @crowi/web type-check

pnpm lint                                    # all apps; errors=0 required
pnpm --filter @crowi/api lint
```

### Build
```bash
pnpm build                                   # all
pnpm --filter @crowi/api-contract build      # required after editing contracts/schemas
```

### Format
```bash
pnpm format                                  # write
pnpm format:check                            # CI
```
Auto-applied on commit via lefthook pre-commit (Biome). `pnpm format` is
manual-only when bypassing hooks.

## Architecture Overview

### API server (`apps/crowi-api`)
- **Boot**: `Crowi.init()` runs `setupEncryption` → `setupDatabase` → `setupModels` → `setupRedisClient` → `setupSessionConfig` → `setupConfig` → `migrateConfig` → `setupSearcher` → `setupMailer` → `setupSlack` → `buildServer`.
- **Routing**:
  - Public ts-rest routes (no auth)
  - Authenticated ts-rest routes under `jwtAuth(crowi)` (most page / user / comment / etc. endpoints)
  - Admin ts-rest routes under `jwtAdminRequired(crowi)` (= JWT + `user.admin === true`)
  - Legacy Express routes still mounted at `/_api/*`, `/login`, `/register`, etc. for back-compat
- **Auth**: JWT (access + refresh tokens). `req.user` is augmented to `UserDocument` via `apps/crowi-api/src/types/express.ts`.
- **Models** (Mongoose):
  - Page (with grant), Revision, User, Comment, Bookmark, Like (on Page), Watcher, Notification, Activity, Config, Backlink, Share, Attachment.
- **Sensitive Config encryption**: `apps/crowi-api/src/util/crypto.ts` provides AES-256-GCM `encrypt` / `decrypt` / `isEncrypted`. Sensitive keys (OAuth secrets, AWS keys, SMTP password, Slack token) are listed in `models/config-sensitive.ts` and auto-encrypted by `Config.updateByParams` / decrypted by `Config.loadAllConfig` when `CROWI_ENCRYPTION_KEY` is set. Legacy plaintext rows pass through; admin can re-encrypt them via `/admin/crypto/reencrypt`.

### Web frontend (`apps/crowi-web`)
- **Routing**: App Router (`src/app/...`) with three Route Groups:
  - `(public)/`: login / register / installer
  - `(auth)/`: gated by `useAuth` redirect; mounts shared header (NotificationBell + admin shortcut + user dropdown)
  - `(admin)/`: gated by `user.admin === true`; renders sidebar + breadcrumb. Non-admin sees `AccessDeniedCard`.
- **Data fetching**: `@tanstack/react-query` everywhere. `apiClient` (initContract → ts-rest client) is created from the shared contracts. Hooks live in `src/lib/use-*.ts`. Convention: `xxxKeys = { all, detail(id) }` query-key factories; mutations invalidate or `setQueryData` on success.
- **Shared UI**: `components/ui/` (shadcn) + cross-cutting primitives `LoadingSpinner` / `ErrorAlert` / `AccessDeniedCard` / `NotFoundCard`.
- **Auth state**: `useAuth` (JWT in client cookie / context).

### ts-rest Contracts (`packages/api-contract`)
- All API contracts and Zod schemas live here, built with tsup (CJS + ESM + .d.ts).
- Mounted under `/api/v2`. Each top-level namespace (`page`, `user`, `bookmark`, `notification`, `admin`, `adminCrypto`, ...) is a `c.router(...)` and exported via `apiContract`.
- Common error schemas in `schemas/common.ts`: `AuthenticationRequiredError`, `AdminRequiredError`, `UserStatusError`, etc. Middlewares return these as JSON instead of redirecting.
- Build after editing: `pnpm --filter @crowi/api-contract build` (turbo pipeline auto-runs `^build` for `dev`, but standalone scripts may need it manually).

## Key Environment Variables

See `apps/crowi-api/.env.sample`. Required / commonly-set:
- `MONGO_URI` — MongoDB connection
- `REDIS_URL` — session / socket.io adapter
- `PASSWORD_SEED` — legacy password hashing seed (still used for fallback verification)
- `CLIENT_URL` — used for CORS in production (defaults allow localhost in dev)
- `CROWI_ENCRYPTION_KEY` — base64-encoded 32-byte AES-256 key for sensitive Config
  encryption. Generate with `openssl rand -base64 32` or
  `pnpm --filter @crowi/api crypto:gen-key`. Optional but strongly recommended;
  when missing, sensitive values are stored as plaintext (legacy mode) and a
  warning is logged on boot.
- `ELASTICSEARCH_URI` — optional, search backend

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
gets re-implemented as a ts-rest endpoint + Next.js page, then the legacy
route is left in place until the new path is verified. Old routes are removed
in a separate clean-up phase.

- Don't touch unrelated legacy code in a migration commit.
- Maintain wire-format / behaviour parity with the legacy endpoint where
  practical so ongoing deployments can switch incrementally.
- New code goes under `routes/ts-rest/`, `(auth)/` / `(admin)/`, `lib/`,
  `components/`. Legacy code lives in `controllers/`, `routes/api/`, etc.

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

### simplify after merge
After merging a worktree, the integrate-worktree skill spawns 3 review agents
(reuse / quality / efficiency) over the merge diff. Findings worth applying
land in a `refactor(merge): ...` commit; advisories that need separate work
go to `TODO.md`.

### Hooks (lefthook)
- **pre-commit**: Biome format on staged files
- **pre-push**: `pnpm lint` (errors=0 required)
- Installed during `pnpm install`.

### Commit messages
- Conventional Commits: `feat(api): ...`, `feat(web): ...`,
  `feat(api-contract): ...`, `fix(...)`, `refactor(...)`, `chore(...)`,
  `docs(todo): ...`.
- Multi-paragraph body explaining WHY when the change isn't obvious.
- End with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
  on Claude-driven commits.

### State directories
- `.migration-state/` (repo root, gitignored except `.gitkeep`): per-task
  files for the `/migrate` workflow.
- `.reviews/` (gitignored): per-skill review notes; not committed.

## Slash Commands / Skills

User-invocable skills (see `.claude/skills/`):
- **`/migrate <feature>`** — runs the planner → implementer → simplify →
  reviewer → committer pipeline for one migration task. State in
  `.migration-state/tasks/<id>.json`.
- **`/integrate-worktree <name>`** — merges a `gw` worktree into main and
  runs simplify. See "Parallel worktree workflow" above.
- **`/simplify <description>`** — 3-agent reuse / quality / efficiency review
  over recent changes; applies low-risk fixes inline.

## Crowi Theme

```
--crowi-primary: #43676b      /* logo green */
--crowi-header:  #263a3c      /* dark header */
--crowi-sidebar: #f8f9fa      /* sidebar background */
```

Avatars use `--crowi-primary` as background with white text for the initials
fallback (see `apps/crowi-web/src/components/user-avatar.tsx`).
