# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the official Crowi image in a pnpm monorepo.
#
# The image is built from a reference *runner project*, NOT from `@crowi/api`
# directly. `@crowi/api` is plugin-free (SDK + core only); the runner project
# owns `@crowi/api` plus a set of first-party plugins + `crowi.config.json`.
# Deploying the runner project therefore yields a tree where every bundled
# driver is present and selectable via `crowi.config.json` with no rebuild.
#
# Two images are built from this one Dockerfile, parameterized by build args:
#   - full (default): RUNNER_APP=@crowi/runner-app  / apps/crowi-runner
#       — all twelve first-party drivers; switch via config, no rebuild.
#   - slim:           RUNNER_APP=@crowi/runner-app-slim / apps/crowi-runner-slim
#       — only the three implicit-default drivers (storage-local + search-mongo
#         + mail-smtp); MongoDB-only; a base for full customization.
#
#   # full (default)
#   docker build -f packages/api/Dockerfile -t crowi:full .
#   # slim
#   docker build -f packages/api/Dockerfile -t crowi:slim \
#     --build-arg RUNNER_APP=@crowi/runner-app-slim \
#     --build-arg RUNNER_APP_DIR=apps/crowi-runner-slim .
#
# Stages:
#   1. base     — Node + pnpm 9.15.9 (matches root packageManager).
#   2. builder  — install the runner-app subgraph, build @crowi/api and all
#                 transitive workspace deps (api-contract, plugin-*, runner)
#                 with tsup/tsc.
#   3. deployer — `pnpm deploy --filter ${RUNNER_APP} --prod` to extract a
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

# Which runner project to build/deploy from. RUNNER_APP is the pnpm package
# name (used by `--filter`); RUNNER_APP_DIR is its path under the repo (used by
# COPY). Defaults select the full image; override both for slim.
ARG RUNNER_APP=@crowi/runner-app
ARG RUNNER_APP_DIR=apps/crowi-runner

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
ARG RUNNER_APP
ARG RUNNER_APP_DIR

# Repo-root metadata + the workspace packages the runner project needs.
# ${RUNNER_APP_DIR} is the reference runner project we build from. apps/crowi-site
# (LP/docs site, unrelated + has a fumadocs postinstall) is intentionally NOT
# copied, keeping the build context lean. We copy all of apps/ so either runner
# project (full or slim) is present; the unused sibling is harmless (pnpm only
# installs the --filter subgraph below).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/ ./packages/
COPY apps/crowi-runner/ ./apps/crowi-runner/
COPY apps/crowi-runner-slim/ ./apps/crowi-runner-slim/

# Install only the runner project's workspace subgraph. `--filter
# ${RUNNER_APP}...` keeps the install limited to the runner-app + its
# transitive workspace deps (@crowi/api + the bundled plugins + api-contract +
# runner) + their external deps.
RUN pnpm install --frozen-lockfile --filter ${RUNNER_APP}...

# Build @crowi/api and all transitive workspace deps (api-contract, plugin-*,
# runner). The `...` syntax expands to "this package + everything it depends on".
# The runner-app itself has no build step (it only declares dependencies).
RUN pnpm --filter ${RUNNER_APP}... build

# -----------------------------------------------------------------------------
# Stage 3: deployer
# -----------------------------------------------------------------------------
# `pnpm deploy` collects the runner-app and its production-only workspace
# deps (@crowi/api + every bundled @crowi/plugin-* + plugin-api + runner) into
# /deploy with the workspace: protocol resolved and node_modules injected. The
# resulting tree is self-contained (no symlinks pointing outside the dir) and
# carries the runner project's package.json + crowi.config.json at its root, so
# `node node_modules/@crowi/api/dist/app.js` boots with /deploy as the
# projectDir and resolves every bundled plugin from there.
#
# NB: @crowi/plugin-api and @crowi/runner are declared as direct deps of the
# runner-app (not only transitively via @crowi/api) precisely so pnpm deploy
# injects them into this tree — a package's transitive workspace deps are
# otherwise left as symlinks to the source checkout, which don't exist here.
FROM builder AS deployer
ARG RUNNER_APP
RUN pnpm deploy --filter=${RUNNER_APP} --prod /deploy

# -----------------------------------------------------------------------------
# Stage 4: runtime
# -----------------------------------------------------------------------------
FROM base AS runtime

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

WORKDIR /app

# Put the deployed tree's bin dir on PATH so the bundled CLIs resolve by name.
# The node base image's `docker-entrypoint.sh` only prepends `node` when the
# first arg is NOT a known command; without .bin on PATH,
# `docker compose run --rm api crowi-admin <cmd>` is mis-read as
# `node crowi-admin` and fails — the operator would otherwise have to spell out
# the full /app/node_modules/.bin/crowi-admin path. Makes `crowi-admin` (admin
# CLI) and `crowi-api` (server bin) directly invocable.
ENV PATH="/app/node_modules/.bin:${PATH}"

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
