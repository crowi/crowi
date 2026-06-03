<div align="center">
  <img src="packages/web/public/logo/500w.png" width="500" alt="Crowi">
</div>

<h1 align="center">Crowi</h1>
<p align="center"><strong>The Markdown Wiki — empower the team with sharing your knowledge.</strong></p>

<div align="center">
  <p align="center">
    <img src="https://github.com/crowi/crowi/actions/workflows/ci.yml/badge.svg" alt="GitHub Actions CI">
  </p>
</div>

> [!CAUTION]
> **Crowi v2 — codename *Reignite* — is under active development.**
>
> - No stable v2 release yet. Do not run this branch in production.
> - Crowi v1.x is deprecated and unmaintained.
> - Track progress in [`TODO.md`](./TODO.md) and the [v2 announcement on Zenn](https://zenn.dev/sotarok/articles/34795a35a4ef74).

## What is Crowi

Crowi is a **Markdown Wiki** for team knowledge sharing. URL paths *are* the
page hierarchy, so `/team/handbook/onboarding` reads exactly the way it's
written. v2 ("Reignite") rebuilds the stack from Express + Swig + jQuery
to a **Hono API + Next.js 16 (App Router) + React 19**, while keeping v1's
MongoDB data shape intact — your existing wiki migrates over.

## Monorepo layout

This repository is a Turborepo + pnpm workspace.

```
crowi/
├── apps/
│   └── crowi-site/        # crowi.wiki LP + docs (Next.js + Fumadocs, port 4303)
├── crowi.config.json      # Dev runner config: plugins + active driver names
├── .env.example           # Dev runtime env template (copy to .env)
└── packages/
    ├── api/                          # Hono 4 API library (port 4301)
    ├── api-contract/                  # Shared Hono (@hono/zod-openapi) contracts + Zod schemas
    ├── web/                           # Next.js 16 frontend (port 4302)
    ├── runner/                        # Config loader + plugin resolver (used by @crowi/api boot)
    ├── plugin-api/                    # Plugin SDK (CrowiPlugin / registries / context)
    ├── plugin-aws/                    # Shared AWS credentials base plugin
    ├── plugin-storage-local/          # Default-on local FS storage driver
    ├── plugin-storage-aws-s3/         # S3 storage driver
    ├── plugin-search-elasticsearch/   # Elasticsearch search driver
    ├── plugin-renderer-emoji/         # `:emoji:` → 🎉 renderer
    ├── plugin-renderer-katex/         # KaTeX math renderer
    ├── plugin-renderer-plantuml/      # PlantUML diagram renderer
    ├── plugin-renderer-crowi-legacy/  # v1-era wikilinks / strikethrough / etc.
    └── admin-cli/                     # `crowi-admin` CLI (init / migrate / re-encrypt)
```

The API package is plugin-agnostic at runtime — `@crowi/runner`
resolves plugin npm names against the runner project's `node_modules/`
via `createRequire(<projectDir>/package.json)`. Operators add a plugin
by declaring it in their runner's `package.json` deps and listing it
in `crowi.config.json:plugins`; the api never needs to be rebuilt.

## Tech stack

- **API**: Hono 4 + `@hono/zod-openapi` + Mongoose + JWT auth (`jwtAuth` middleware)
- **Web**: Next.js 16 (App Router, Turbopack) + React 19 + Tailwind CSS v4 + shadcn/ui + @tanstack/react-query
- **Site**: Next.js 16 (static export) + Fumadocs UI + i18n (ja / en)
- **Shared**: TypeScript 5.x strict, pnpm workspaces, Turborepo
- **Lint / Format**: Biome (format) + ESLint (lint), lefthook hooks
- **Tests**: Jest + supertest + mongodb-memory-server (API)

## Requirements

- Node.js 24.x
- pnpm 8.x or later
- MongoDB
- Redis
- Elasticsearch (optional, plugin-driven)
- Docker / Docker Compose (for local infrastructure)

## Local development

```bash
# 1. Install dependencies
pnpm install

# 2. Start dependency services (MongoDB / Redis / Elasticsearch / PlantUML)
docker compose up -d

# 3. Set up env file at the repo root (loaded by the api at boot via dotenv)
cp .env.example .env
# Edit MONGO_URI / REDIS_URL / PASSWORD_SEED / CROWI_ENCRYPTION_KEY etc.

# 4. Run everything (api on :4301, web on :4302, plugins compiled in watch mode)
pnpm dev
```

Other targeted scripts:

```bash
pnpm dev:api       # just the API + plugins (no Next.js)
pnpm dev:web       # just the Next.js frontend
pnpm dev:site      # crowi.wiki LP + docs (port 4303)
```

## Environment variables

`.env.example` (at the repo root) lists the full set. Highlights:

| Variable | Purpose |
| --- | --- |
| `MONGO_URI` | MongoDB connection string |
| `REDIS_URL` | Sessions + socket.io adapter (use `rediss://` for TLS) |
| `PASSWORD_SEED` | Legacy password hashing seed (still used for fallback verification) |
| `CLIENT_URL` | CORS allowlist origin in production (defaults allow localhost in dev) |
| `CROWI_ENCRYPTION_KEY` | Base64-encoded 32-byte AES-256 key for sensitive Config encryption. Generate via `openssl rand -base64 32` or `pnpm --filter @crowi/api crypto:gen-key`. Strongly recommended to set; missing key falls back to plaintext (legacy behaviour) with a startup warning. |
| `PORT` | API server port (default `4301`) |
| `NODE_ENV` | `production` or `development` |

Storage backend selection is driven by the runner's `crowi.config.json`
(`storage.driver: 'local' | 's3' | ...`) plus the corresponding
`@crowi/plugin-storage-*` package — there is no `FILE_UPLOAD` env any
more.

## Tests / type-check / lint / build

```bash
pnpm test                                  # all apps
pnpm --filter @crowi/api test              # api only
pnpm type-check                            # api + web + site
pnpm lint                                  # all apps; errors=0 required
pnpm build                                 # all
pnpm --filter @crowi/api-contract build    # required after editing contracts
```

Format runs automatically via lefthook on commit (Biome).
Manual: `pnpm format` / `pnpm format:check`.

## Plugins

Plugins are regular npm packages declared in the runner project's
dependencies and listed in `crowi.config.json:plugins`. The shipped
first-party plugins live under `packages/plugin-*/`:

- **Storage**: `plugin-storage-local` (default), `plugin-storage-aws-s3`
- **Search**: `plugin-search-elasticsearch`
- **Renderers**: `plugin-renderer-emoji`, `plugin-renderer-katex`, `plugin-renderer-plantuml`, `plugin-renderer-crowi-legacy`

Write your own by depending on `@crowi/plugin-api`, exporting a default
`CrowiPlugin`, and adding the package name to your runner's
`crowi.config.json`.

## License

The MIT License (MIT). See [`LICENSE`](./LICENSE).
