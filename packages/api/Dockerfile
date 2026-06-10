# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the official **full** Crowi image in a pnpm monorepo.
#
# The image is built from the reference runner project `@crowi/runner-app`
# (apps/crowi-runner), NOT from `@crowi/api` directly. `@crowi/api` is
# plugin-free (SDK + core only); the runner project owns `@crowi/api` plus
# the full first-party plugin set + `crowi.config.json`. Deploying the runner
# project therefore yields a batteries-included tree: every driver is present
# and selectable via `crowi.config.json` with no rebuild.
#
# Stages:
#   1. base     — Node + pnpm 9.15.9 (matches root packageManager).
#   2. builder  — install the runner-app subgraph, build @crowi/api and all
#                 transitive workspace deps (api-contract, plugin-*, runner)
#                 with tsup/tsc.
#   3. deployer — `pnpm deploy --filter @crowi/runner-app --prod` to extract a
#                 self-contained runtime tree (the runner project's package.json
#                 + crowi.config.json + production node_modules with @crowi/api
#                 and every bundled plugin resolved to concrete paths).
#   4. runtime  — minimal Node image with only the deployed tree + non-root
#                 user.
#
# Build context: repository root (`docker build -f packages/api/Dockerfile .`).
# The runner project's bundled `crowi.config.json` IS baked in (it only selects
# active drivers — no secrets). Operators override driver selection by mounting
# their own `crowi.config.json` at /app/crowi.config.json; per-driver
# credentials live in the Mongo Config collection, edited from the admin UI.
#
ARG NODE_VERSION=24-bookworm-slim

# -----------------------------------------------------------------------------
# Stage 1: base
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /workspace

# -----------------------------------------------------------------------------
# Stage 2: builder
# -----------------------------------------------------------------------------
FROM base AS builder

# Repo-root metadata + the workspace packages the runner project needs.
# apps/crowi-runner is the reference runner project we build from. apps/crowi-site
# (LP/docs site, unrelated + has a fumadocs postinstall) is intentionally NOT
# copied, keeping the build context lean.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/ ./packages/
COPY apps/crowi-runner/ ./apps/crowi-runner/

# Install only the runner project's workspace subgraph. `--filter
# @crowi/runner-app...` keeps the install limited to the runner-app + its
# transitive workspace deps (@crowi/api + the bundled plugins + api-contract +
# runner) + their external deps.
RUN pnpm install --frozen-lockfile --filter @crowi/runner-app...

# Build @crowi/api and all transitive workspace deps (api-contract, plugin-*,
# runner). The `...` syntax expands to "this package + everything it depends on".
# runner-app itself has no build step (it only declares dependencies).
RUN pnpm --filter @crowi/runner-app... build

# -----------------------------------------------------------------------------
# Stage 3: deployer
# -----------------------------------------------------------------------------
# `pnpm deploy` collects @crowi/runner-app and its production-only workspace
# deps (@crowi/api + every bundled @crowi/plugin-* + plugin-api + runner) into
# /deploy with the workspace: protocol resolved and node_modules injected. The
# resulting tree is self-contained (no symlinks pointing outside the dir) and
# carries the runner project's package.json + crowi.config.json at its root, so
# `node node_modules/@crowi/api/dist/app.js` boots with /deploy as the
# projectDir and resolves every bundled plugin from there.
#
# NB: @crowi/plugin-api and @crowi/runner are declared as direct deps of
# @crowi/runner-app (not only transitively via @crowi/api) precisely so pnpm
# deploy injects them into this tree — a package's transitive workspace deps are
# otherwise left as symlinks to the source checkout, which don't exist here.
FROM builder AS deployer
RUN pnpm deploy --filter=@crowi/runner-app --prod /deploy

# -----------------------------------------------------------------------------
# Stage 4: runtime
# -----------------------------------------------------------------------------
FROM base AS runtime

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

WORKDIR /app

# Copy the deployed runner-project tree (package.json, crowi.config.json,
# node_modules/ with @crowi/api + bundled plugins). /app is the runner
# project root = the api's projectDir. The built-in `node` user (uid 1000)
# ships with node:bookworm-slim — chown to it so the process runs unprivileged.
COPY --from=deployer --chown=node:node /deploy /app

USER node

EXPOSE 3000

# Direct `node` invocation avoids PID 1 / signal-handling issues that arise
# when going through `npm start` -> shell -> node. The api dist lives under the
# runner project's node_modules; running it with WORKDIR=/app means
# PluginManager.bootstrap() resolves projectDir=process.cwd()=/app and finds
# crowi.config.json + the bundled plugins there. (Equivalent to the runner
# project's `npm start` = `crowi-api` bin, minus the shell hop.)
CMD ["node", "node_modules/@crowi/api/dist/app.js"]
