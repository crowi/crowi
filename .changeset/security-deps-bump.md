---
'@crowi/api': patch
'@crowi/api-contract': patch
'@crowi/web': patch
'@crowi/plugin-search-elasticsearch': patch
---

Bump dependencies to clear Dependabot security advisories. Direct deps lifted so
transitive chains resolve to the patched versions:

- `hono` 4.10.0 → 4.12.25 (GHSA-88fw-hqm2-52qc / GHSA-rv63-4mwf-qqc2 /
  GHSA-wgpf-jwqj-8h8p / GHSA-wwfh-h76j-fc44 / GHSA-j6c9-x7qj-28xf)
- `ws` 8.20.1 → 8.21.0 (GHSA-96hv-2xvq-fx4p)
- `@elastic/elasticsearch` 9.4.0 → 9.4.2 — pulls `@elastic/transport` 9.3.7 and
  `@opentelemetry/core` 2.8.0 (GHSA-8988-4f7v-96qf)
- `fumadocs-core` / `fumadocs-mdx` / `fumadocs-ui` to their 16.10.4 / 15.0.12
  lines, `eslint-config-next` 16.1.1 → 16.2.9, `vitest` 4.1.6 → 4.1.9,
  `@vitejs/plugin-react` 6.0.1 → 6.0.2 — pull `@babel/core` 7.29.7 and
  `esbuild` 0.28.1 (GHSA-4x5r-pxfx-6jf8 / GHSA-g7r4-m6w7-qqqr)
- `form-data` ^4.0.6 and `vite` ^8.0.16 lifted into the dev dependencies of
  `packages/api` / `packages/web` / `apps/crowi-site` so the lockfile resolver
  picks the patched range that supertest / vitest / fumadocs-mdx /
  `@vitejs/plugin-react` could not reach via peer constraints alone (form-data:
  GHSA-hmw2-7cc7-3qxx; vite: GHSA-fx2h-pf6j-xcff / GHSA-v6wh-96g9-6wx3).

The remaining `js-yaml` (eslint 8 chain) and `ip-address` (mongoose 8 →
mongodb → socks chain) advisories require eslint 8 → 9 and mongoose 8 → 9
major upgrades respectively.
