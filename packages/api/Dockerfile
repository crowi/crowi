# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @crowi/api in a pnpm monorepo.
#
# Stages:
#   1. base     — Node 22 + pnpm 9.15.9 (matches root packageManager).
#   2. builder  — install all workspace deps, build @crowi/api and its
#                 transitive workspace deps with tsup/tsc.
#   3. deployer — `pnpm deploy --filter @crowi/api --prod` to extract a
#                 self-contained runtime tree (dist + production node_modules
#                 with workspace deps resolved to concrete paths).
#   4. runtime  — minimal Node image with only the deployed tree + non-root
#                 user.
#
# Build context: repository root (`docker build -f packages/api/Dockerfile .`).
# Operator MUST mount their own `crowi.config.json` at /app/crowi.config.json
# (image intentionally does NOT bake this in — see spec §c).
#
ARG NODE_VERSION=22-bookworm-slim

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

# Repo-root metadata + the workspace packages api needs. apps/ is NOT
# copied — it only contains crowi-site (LP/docs site, unrelated to api +
# has a fumadocs postinstall we don't want to run on every api build).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/ ./packages/

# Install only the api's workspace subgraph. `--filter @crowi/api...` keeps
# the install limited to api + transitive workspace deps + their external
# deps — no plugin-renderer-katex etc. unless api actually depends on them.
RUN pnpm install --frozen-lockfile --filter @crowi/api...

# Build @crowi/api and all transitive workspace deps (api-contract, plugin-*,
# runner). The `...` syntax expands to "this package + everything it depends on".
RUN pnpm --filter @crowi/api... build

# -----------------------------------------------------------------------------
# Stage 3: deployer
# -----------------------------------------------------------------------------
# `pnpm deploy` collects @crowi/api and its production-only workspace deps into
# /deploy with workspace: protocol resolved and node_modules hoisted. The
# resulting tree is self-contained and free of dev deps / symlinks pointing
# outside the directory.
FROM builder AS deployer
RUN pnpm deploy --filter=@crowi/api --prod /deploy

# -----------------------------------------------------------------------------
# Stage 4: runtime
# -----------------------------------------------------------------------------
FROM base AS runtime

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

WORKDIR /app

# Copy the deployed tree (dist/, node_modules/, package.json). The built-in
# `node` user (uid 1000) ships with node:bookworm-slim — chown to it so the
# process runs unprivileged.
COPY --from=deployer --chown=node:node /deploy /app

USER node

EXPOSE 3000

# Direct `node` invocation avoids PID 1 / signal-handling issues that arise
# when going through `npm start` -> shell -> node. dist/app.js is produced
# from packages/api/src/app.ts (shebang preserved by tsc; see Phase 7).
CMD ["node", "dist/app.js"]
