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
├── apps/crowi-site/          # crowi.wiki LP + docs (Next.js + Fumadocs, :3401)
├── crowi.config.json         # dev runner config (plugins + active drivers)
├── .env(.sample)             # dev runtime env (loaded at CWD by packages/api)
└── packages/
    ├── api/                  # Express + ts-rest API (:3300)
    ├── api-contract/         # ts-rest contracts + Zod schemas
    ├── web/                  # Next.js 16 App Router (:3301)
    ├── runner/               # config loader + plugin resolver (used by api boot)
    ├── tsconfig/             # shared library/app-node/app-web tsconfig presets
    ├── admin-cli/            # `crowi-admin` CLI
    └── plugin-{api,aws,storage-*,renderer-*,search-elasticsearch}/
```

`ls packages/` and `tree -L 2 packages/api/src` give the rest. Highlights
worth knowing without reading code:

- `packages/api/src/routes/ts-rest/` — new endpoints; `routes/api/` + `controllers/` are legacy
- `packages/api/src/crowi/index.ts` — boot sequence (encryption → DB → config → plugins → server)
- Plugin resolution: `@crowi/runner` reads `crowi.config.json` + uses
  `createRequire(<projectDir>/package.json)` to load plugin npm packages from
  the runner's `node_modules/`. Operators add a plugin by declaring it in
  their runner's deps + listing in `crowi.config.json:plugins`; the api never
  needs to be rebuilt. Dev path: `projectDir` = repo root, plugins resolve
  via pnpm's hoisted `node_modules/` (see `.npmrc`).

## Tech Stack

- **API**: Express 4 + ts-rest 3 + Mongoose + JWT auth (`jwtAuth` middleware)
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
- **Realtime collab dev**: `pnpm dev` is enough — `@crowi/collab` is attached
  as a library inside the api process (RFC-0003 §"Implementation notes"), so
  there is no separate collab process / port to manage. To smoke-test collab
  locally, open `http://localhost:3301/_edit?page_id=<pageId>` in two browser
  windows (Chrome regular + Incognito, signed in as different users) and
  verify that typing in one window appears in the other.

## Architecture Overview

### API server (`packages/api`)
- **Boot**: `Crowi.init()` runs `setupEncryption` → `setupDatabase` → `setupModels` → `setupRedisClient` → `setupSessionConfig` → `setupConfig` → `migrateConfig` → `setupSearcher` → `setupMailer` → `setupSlack` → `buildServer`.
- **Routing**:
  - Public ts-rest routes (no auth)
  - Authenticated ts-rest routes under `jwtAuth(crowi)` (most page / user / comment / etc. endpoints)
  - Admin ts-rest routes under `jwtAdminRequired(crowi)` (= JWT + `user.admin === true`)
  - Legacy Express routes still mounted at `/_api/*`, `/login`, `/register`, etc. for back-compat
- **Auth**: JWT (access + refresh tokens). `req.user` is augmented to `UserDocument` via `packages/api/src/types/express.ts`.
- **Models** (Mongoose):
  - Page (with grant), Revision, User, Comment, Bookmark, Like (on Page), Watcher, Notification, Activity, Config, Backlink, Share, Attachment.
- **Sensitive Config encryption**: `packages/api/src/util/crypto.ts` provides AES-256-GCM `encrypt` / `decrypt` / `isEncrypted`. Sensitive keys (OAuth secrets, AWS keys, SMTP password, Slack token) are listed in `models/config-sensitive.ts` and auto-encrypted by `Config.updateByParams` / decrypted by `Config.loadAllConfig` when `CROWI_ENCRYPTION_KEY` is set. Legacy plaintext rows pass through; admin can re-encrypt them via `/admin/crypto/reencrypt`.
- **Realtime collab (RFC-0003)**: Hocuspocus is attached to the api process as a library via `packages/api/src/collab/attach.ts`, using the api's `http.Server` in `ws noServer` mode for `/collab/*` upgrades. When `crowi.redis !== null` (i.e. `REDIS_URL` is set), `@hocuspocus/extension-redis` is auto-attached so multi-instance deployments work without sticky sessions. See `docs/rfcs/0003-realtime-collaborative-editing.md` for the design and `apps/crowi-site/content/docs/{ja,en}/operations/realtime-collab.mdx` for operator instructions.

### Web frontend (`packages/web`)
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

See `.env.sample` at the repo root. Required / commonly-set:
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

### Changesets (release notes accumulation)

Phase 9 で `@changesets/cli` を導入済み。v2 開発中も `pnpm changeset add`
で各リリース対象の変更を `.changeset/*.md` として **蓄積していく** ことで、
2.0.0-alpha1 / 安定版リリース時に過去変更のリリースノートが自動生成される。

**Add のタイミング — 「ユーザー価値の単位」で 1 つ**:
- ✅ 機能追加・バグ修正・破壊的変更 → 1 changeset
- ✅ 同じ機能を分割した複数 commit でも、ユーザー視点で 1 つなら 1 changeset
  (実装途中の小さな commit ごとに changeset は **作らない**)
- ❌ 内部 refactor / コード整理 / lint fix / format / 内部 build infra
  / test 追加だけ → changeset 不要 (ユーザーから見える変化なし)
- ❌ docs(todo) / CLAUDE.md / `.claude/` 更新 → changeset 不要
- ❌ `feature-monorepo-packages-restructure` の各 phase commit → 全体で 1
  changeset (`.changeset/initial-release.md` で既に拾われている)

判断基準: 「次の changelog に書いて意味があるか」。`feat:` / `fix:` で
ユーザー behavior が変わるなら add、`refactor:` / `chore:` / `test:` /
`docs:` だけなら add しない。

**Bump レベルの選び方**:
- `patch` — bug fix、内部最適化が露出するもの、依存 bump (semver-safe)
- `minor` — 新機能、新エンドポイント、既存挙動を壊さない設定追加
- `major` — 破壊的変更 (API 削除、エンドポイント仕様変更、required 設定追加)

**対象 package の選び方**:
- API 振る舞いを変えた → `@crowi/api`
- Web UI を変えた → `@crowi/web` (private なので登録しても publish はされない
  が、CHANGELOG.md は生成される)
- ts-rest contract を変えた → `@crowi/api-contract` (linked group なので
  api / web も同時 bump される)
- Plugin SDK を拡張した → `@crowi/plugin-api` + 影響する個別 plugin
- Plugin 1 つだけ更新 → その plugin のみ

**コマンド**:
```bash
pnpm changeset add        # 対話的に package + bump level + 概要を選ぶ
pnpm changeset status     # 蓄積された未公開 changeset 一覧
```

PR を main に merge する直前 (or PR の中) で 1 ファイル add する運用。
初版 (`.changeset/initial-release.md`) は restructure 全体を覆う sentinel
として `feature-monorepo-packages-restructure` 完了時に置いた、消さない。

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

Tokens live in `packages/web/src/app/globals.css` (`--crowi-primary` /
`--crowi-header` / `--crowi-sidebar` etc.). Avatars use `--crowi-primary` as
initials-fallback background (`packages/web/src/components/user-avatar.tsx`).
