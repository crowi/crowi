# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @crowi/web using Next.js standalone output.
#
# Stages:
#   1. base     — Node 24 + pnpm 10.34.3 (matches root packageManager).
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
# RUNTIME-CONFIGURED API URL: this image bakes NO absolute API URL. The browser
# hits `/api/v2/...`,`/files/...` on its own origin (relative paths — see
# `src/lib/api-client.ts`) and derives WS URLs from `window.location`.
# RECOMMENDED TOPOLOGY: put a front reverse proxy (Caddy / nginx) in front that
# routes `/api`,`/files`,`/collab`,`/presence`,`/notifications` to the api and
# everything else to this web server — one built image then works against any
# api host with no rebuild. NOTE: `next.config.ts`'s `rewrites()` proxy is baked
# at build for `output: 'standalone'`, so `CROWI_API_URL` does NOT runtime-config
# the standalone server's proxy (it only applies in `pnpm dev` / on Vercel's
# edge) — do not rely on Next to proxy `/api` in self-host prod; use the front
# proxy. Cross-origin overrides (`NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_COLLAB_URL`)
# are read at runtime via window.__ENV. See operations/deployment in the docs.
#
ARG NODE_VERSION=24-bookworm-slim

# -----------------------------------------------------------------------------
# Stage 1: base
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS base
RUN corepack enable && corepack prepare pnpm@10.34.3 --activate
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

# No NEXT_PUBLIC_API_URL is baked here on purpose: the browser uses relative
# `/api/v2` paths and WS URLs derived from `window.location`, so the API URL is
# supplied at runtime via `CROWI_API_URL` (see the runtime stage below). This
# keeps the image generic across deployments.

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

# NOTE: `CROWI_API_URL` (the `next.config.ts` `rewrites()` proxy target) is
# BAKED AT BUILD for `output: 'standalone'` — the runtime `node server.js` does
# NOT re-read it. It only applies in `pnpm dev` / on Vercel's edge. For
# self-host production, front this image with a reverse proxy that routes
# /api,/files,WS to the api (see the comment at the top of this file and
# operations/deployment); do not rely on the web server to proxy /api itself.

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
