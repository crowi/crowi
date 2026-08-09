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

`ls packages/` and `tree -L 2 packages/api/src` give the layout. Highlights
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

## Development Commands

Scripts live in root + per-package `package.json`. `pnpm <script>` filters with
`turbo` automatically. Non-obvious points:

- **Dev**: `docker compose up -d` for infra (mongo/redis/es/plantuml) →
  `pnpm dev` for api+web+plugins. `pnpm dev:api` / `pnpm dev:web` for one side.
  `pnpm dev` builds every workspace lib/plugin **once** up front (turbo-cached),
  then keeps only `@crowi/api` (tsx), `@crowi/web` (next) and `@crowi/api-contract`
  under a persistent watch — the latter JS-only, since its `.d.ts` rollup worker
  alone holds several GiB resident. Editing a lib/plugin? Add it back to the live
  watch with `pnpm dev --watch <pkg>` (repeatable; `plugin-slack` or
  `@crowi/plugin-slack`). `pnpm dev --watch @crowi/api-contract` also restores
  live `.d.ts` regeneration for contract edits.
- **Test infra**: `docker compose up -d` also starts `crowi-test-mongodb` (port
  27018, tmpfs data dir), a MongoDB dedicated to `@crowi/api`'s jest suite and
  kept independent from the always-on dev `mongodb` (27017) — a full parallel
  run's per-file create-db/autoIndex/dropDatabase churn no longer competes
  with dev data for the same disk path. tmpfs means it is fully disposable:
  a restart or `docker compose down` loses all data with no consequence
  (tests only ever write per-file scratch databases their own teardown
  already drops). `packages/api/src/test/global-setup.js` probes 27018 first,
  falls back to the dev `mongodb` (27017), and finally to an in-process
  `mongodb-memory-server` when neither is reachable — a checkout that hasn't
  pulled this compose change keeps working unchanged.
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
- **Routing** (all Hono, mounted under `/api`):
  - Public routes (no auth)
  - Authenticated routes under `createJwtAuth(crowi)` (most page / user / comment / etc. endpoints)
  - Admin routes under `createJwtAdminRequired(crowi)` (= JWT + `user.admin === true`)
- **Auth**: JWT (access + refresh tokens). `req.user` is augmented to `UserDocument` via `packages/api/src/types/express.ts`.
- **Sensitive Config encryption**: `packages/api/src/util/crypto.ts` provides AES-256-GCM `encrypt` / `decrypt` / `isEncrypted`. Sensitive keys are registered in `models/config-sensitive.ts`: a static set for the few that remain in core config (OAuth secrets, Slack token) plus a runtime set that each plugin's `@sensitive` config fields (storage / mail credentials etc.) register at boot. They are auto-encrypted by `Config.updateByParams` / decrypted by `Config.loadAllConfig` when `CROWI_ENCRYPTION_KEY` is set. Legacy plaintext rows pass through; admin can re-encrypt them via `/admin/crypto/reencrypt`.
- **Realtime collab (RFC-0003)**: Hocuspocus is attached to the api process as a library via `packages/api/src/collab/attach.ts`, using the api's `http.Server` in `ws noServer` mode for `/collab/*` upgrades. When `crowi.redis !== null` (i.e. `REDIS_URL` is set), `@hocuspocus/extension-redis` is auto-attached so multi-instance deployments work without sticky sessions. See `docs/rfcs/0003-realtime-collaborative-editing.md` for the design and `apps/crowi-site/content/docs/{ja,en}/operations/realtime-collab.mdx` for operator instructions.

### Web frontend (`packages/web`)
- **Data fetching**: `@tanstack/react-query` everywhere. `apiClientV2` (a `CrowiApiClient`, built by `createClient(...)`) is the typed Hono RPC client for the whole route surface. Hooks live in `src/lib/use-*.ts`. Convention: `xxxKeys = { all, detail(id) }` query-key factories; mutations invalidate or `setQueryData` on success.

### API Contracts (`packages/api-contract`)
- Contracts are `@hono/zod-openapi` `createRoute(...)` route definitions, grouped per namespace (`page`, `user`, `bookmark`, `notification`, `admin`, `adminCrypto`, ...). `client.ts` composes them into `CrowiApiClient`, the intersection of several `OpenAPIHono` chains (split to avoid TS2589 — see the note there); `createClient(...)` is the sole way to obtain one.
- Common error schemas in `schemas/common.ts`: `AuthenticationRequiredError`, `AdminRequiredError`, `UserStatusError`, etc. Middlewares return these as JSON instead of redirecting.

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

### main write lock (serializing concurrent sessions)

Multiple agent sessions may operate on this repo concurrently. **Any
operation that changes main's git state** (committing on main, merging,
`git reset` on main) must first acquire the advisory lock:

```bash
( set -o noclobber; printf '{ "owner": "<who>", "purpose": "<1 line>", "at": "%s" }\n' \
    "$(date -u +%FT%TZ)" > .feature-state/main-write.lock ) 2>/dev/null \
  || { cat .feature-state/main-write.lock; }   # busy: wait or report — do NOT steal
```

Remove the file when done (also on abort). If the lock looks stale
(>30 min old), surface it to the human instead of deleting it yourself.
Working-tree edits and commits on worktree branches do NOT need the lock.
Additionally, **never `git reset --hard` on main without first checking
`git log --oneline <target>..HEAD` for commits that are not yours**.

(Born from a real 2026-07-06 incident: two sessions interleaved a merge
and a commit on main — one commit consumed the other's MERGE_HEAD, and a
later reset --hard destroyed the first session's commit; recovered from
the reflog.)

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
Each worktree gets a deterministic 4-port block; the proxy (`anchor+3`) — not
the raw web port — is the canonical dev entry point. Details (port allocation,
dev portal on `:4300`, tailscale serve, mongo DB isolation, the `4300-4999`
reserved band): see the `crowi-dev-ports` skill.

### simplify after merge
After merging a worktree, the integrate-worktree skill spawns review agents
(reuse / simplification / efficiency / altitude) over the merge diff. Every
finding is either **fixed on the spot** (a `refactor(merge): ...` commit) or
**dropped**. Fix discipline (integrate-worktree Step 7 is authoritative):
mechanical fixes (dead code, reuse an existing helper) may be applied
directly; behavioral fixes (writing new logic to answer a finding) default
to drop, and when fixed follow crowi-fix discipline (failing repro test
first). Any applied fixes must pass a codex 1-pass adversarial review
BEFORE the refactor(merge) commit — the merged worktree code went through
the feature pipeline's review, but simplify fixes are written ad hoc by the
integrating session and previously landed on main with no independent check.

### Review findings: fix or drop (applies everywhere)
Review / simplify / QA findings are NEVER parked in `TODO.md` or any backlog.
The only two outcomes are: fix it now, or drop it (report the drop in one
line). This applies to every skill and agent (feature pipeline, crowi-review,
integrate-worktree, orchestrate C, crowi-fix, future skills). `TODO.md` is for
roadmap items and blocked dependency majors only — not a review-advisory
graveyard.

### Flaky test / CI-infra root cause: delegate the investigation+design, don't reason it out inline
When a CI failure turns out to be flaky/nondeterministic or CI-infra-shaped
(turbo build/task-graph races, jest harness/worker behavior, GHA runner
timing, port/process reuse) rather than a straightforward deterministic
regression, **do not diagnose the root cause and design the fix by reasoning
inline in a Claude Sonnet session.** Stop, and hand the investigation +
countermeasure design to Codex at `--tier sol` (`.claude/scripts/codex-run.sh
--tier sol`, `gpt-5.6-sol`, high effort) or a Fable-model subagent (`Agent`
with `model: "fable"`). Claude's job is to execute/glue/gate the design that
comes back — write the repro, apply the fix, run the gates, commit — not to
originate the root-cause theory itself.

**Why**: Sonnet's fast single-pass diagnosis on parallel flake/CI-infra
symptoms has repeatedly produced plausible-but-wrong root causes (2026-07-15:
3 consecutive premise errors in one session, each caught only by an
independent spec review — see the flake/CI diagnosis review-gate feedback in
memory). These mechanisms (turbo cache/task-graph ordering, jest reporter/
worker-crash semantics, supertest's ephemeral local server, mongodb driver
pool behavior) don't yield to intuition; they need a harder, separately-
verified reasoning pass before code changes.

**How to apply**: mid-investigation, the moment a CI failure looks
flaky/infra-shaped instead of a deterministic repro-first bug (the normal
crowi-fix case), stop inline investigation. Route the diagnosis + design step
through Codex sol or Fable, then implement from that design under the normal
gates (repro → fix → type-check/test/lint → commit). Skipping this and just
committing an inline Sonnet-authored theory is the failure mode this rule
exists to prevent.

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

Accumulate a `.changeset/*.md` per unit of user value (`feat:` / `fix:` that
changes user behavior); skip pure `refactor:` / `chore:` / `test:` / `docs:`.
Bodies in English. For the full decision rules, bump levels, target-package
table, and commands: see the `crowi-changesets` skill.

### State directories
- `.reviews/` (gitignored): per-skill review notes; not committed.

### Design / spec drafts: never auto-commit, use `.feature-state/specs/`

Any agent working in this repo (Claude Code, Codex, or a third-party skill
pack such as "Superpowers") that produces a design/spec/plan document as
part of a feature or fix must:

- **Never `git add`/`git commit` the document automatically.** Write the
  file and present it; commit only after an explicit "commit it"
  instruction from the human. This matches crowi's own spec convention
  (`.feature-state/specs/` is a non-commit working draft — see
  `crowi-design`/`crowi-kickoff` above), which an external skill pack's own
  default workflow (e.g. a scripted "commit the spec to the working
  branch" step) does not know about and will otherwise silently override.
- **Place the file at `.feature-state/specs/<id>.md`**, not a
  skill-specific path like `docs/superpowers/specs/...` — this is the
  directory `/crowi-kickoff` and `/crowi-feature` actually read from, and
  it is gitignored (drafts never land in history unless explicitly
  promoted).

(Born from a 2026-07-20 incident: a Codex session running a "Superpowers"
skill pack auto-committed a design doc to `docs/superpowers/specs/` inside
a crowi worktree, following that skill's own scripted commit step instead
of this repo's convention.)

### Wiki page writes (mandatory two-step — no inline body)

**Never compose a `crowi_update_page` / `crowi_create_page` body inline as a
tool-call argument reasoned in the moment.** Always:

1. `Write` the full intended body to a scratch file first.
2. `Read` that file back — the content you pass to the MCP call must be what
   the Read tool just returned, not something recalled/retyped from memory.
3. If the exact body is not ready yet, do not call the tool at all — never
   pass a stand-in string ("-- see file --", "TBD", etc.) "to fix in the next
   call". There is no such thing as a placeholder wiki write; every call must
   carry the real content.
4. After the call returns, check the response body's length against the
   scratch file's length. If they diverge, immediately `crowi_get_page` to
   confirm the live page and redo the write before moving on to anything else.

(Born from a real 2026-07-08/09 incident: `crowi_update_page` was called
twice with a literal placeholder string as the body, overwriting the real
page content until the next call. Caught immediately both times only because
the next action happened to be reading the page back — this protocol removes
the dependency on noticing by chance. A memory note alone did not prevent the
second occurrence within the same session; this rule lives in CLAUDE.md
specifically because CLAUDE.md is always loaded into context, unlike memory
files, which are retrieved conditionally.)

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
