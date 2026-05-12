# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @crowi/web using Next.js standalone output.
#
# Stages:
#   1. base     — Node 22 + pnpm 9.15.9 (matches root packageManager).
#   2. builder  — install all workspace deps, run `next build` which emits
#                 a self-contained `.next/standalone/` tree thanks to
#                 `output: 'standalone'` + `outputFileTracingRoot` in
#                 packages/web/next.config.ts.
#   3. runtime  — minimal Node image with the standalone tree + .next/static
#                 + public/ copied in. No pnpm / node_modules install at
#                 runtime.
#
# Build context: repository root (`docker build -f packages/web/Dockerfile .`).
#
# NOTE: `NEXT_PUBLIC_*` env vars are inlined at build time. To deploy this
# image against a different API URL, rebuild with a new
# `--build-arg NEXT_PUBLIC_API_URL=...`. docker-compose passes the
# service-name URL (`http://api:3000`) by default.
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

# Repo-root metadata + the workspace packages web needs. apps/ is NOT
# copied — it only contains crowi-site (separate LP/docs Next.js app with
# its own fumadocs postinstall we don't want triggered here).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/ ./packages/

# Install only @crowi/web's workspace subgraph.
RUN pnpm install --frozen-lockfile --filter @crowi/web...

# NEXT_PUBLIC_* values are baked into the build at compile time. Provide a
# sensible compose default; override with `--build-arg` for other deployments.
ARG NEXT_PUBLIC_API_URL=http://api:3000
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

# Runs paraglide:compile via the prebuild hook in packages/web/package.json,
# then `next build` produces `.next/standalone/` + `.next/static/`.
RUN pnpm --filter @crowi/web... build

# -----------------------------------------------------------------------------
# Stage 3: runtime
# -----------------------------------------------------------------------------
FROM base AS runtime

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

WORKDIR /app

# Standalone tree mirrors the monorepo path layout — server.js sits at
# /app/packages/web/server.js. `.next/static` and `public/` are NOT included
# in the standalone tree and must be copied next to it manually.
COPY --from=builder --chown=node:node /workspace/packages/web/.next/standalone /app
COPY --from=builder --chown=node:node /workspace/packages/web/.next/static /app/packages/web/.next/static
COPY --from=builder --chown=node:node /workspace/packages/web/public /app/packages/web/public

USER node

EXPOSE 3000

WORKDIR /app/packages/web
CMD ["node", "server.js"]
