---
'@crowi/api': patch
'@crowi/api-contract': patch
'@crowi/plugin-api': patch
'@crowi/plugin-slack': patch
---

Bump dependencies to clear Dependabot security advisories (alerts #622/#623/#626-#637).

- `sharp` 0.34.5 → 0.35.3, direct in `@crowi/api` (GHSA sharp <0.35.0). Also
  overridden repo-wide (`sharp@<0.35.3` → `0.35.3`) since Next.js pins an
  optional `sharp: ^0.34.5` dependency of its own that a Next.js version bump
  can't escape.
- `@hono/node-server` 2.0.3 → 2.0.11, direct in `@crowi/api` (GHSA-frvp-7c67-39w9
  path traversal / GHSA-9mqv-5hh9-4cgg WS handshake DoS). Also overridden
  (`@hono/node-server@<2.0.11` → `2.0.11`) for the transitive 1.19.14
  resolution pulled in by `@modelcontextprotocol/sdk`'s own `dependencies` —
  verified crowi never imports the SDK module that requires it
  (`@hono/mcp`'s `StreamableHTTPTransport` mounts into our own existing Hono
  app/server instead), so this resolution was unreachable dead code, but the
  override closes the alert cleanly regardless.
- `hono` bumped to 4.12.31 (within the existing `^4.12.25` range) across
  `@crowi/api` / `@crowi/api-contract` / `@crowi/plugin-api` / `@crowi/plugin-slack`.
- `js-yaml` overridden to `3.15.0` / `4.3.0` per major line
  (`js-yaml@>=3.0.0 <3.15.0` / `js-yaml@>=4.0.0 <4.3.0`) — covers every
  transitive consumer (jest/istanbul's 3.x chain, eslint 8/9, changesets,
  the mjml/htmlnano chain, fumadocs, `@redocly/openapi-core`) plus
  `@crowi/api-contract`'s own direct `js-yaml` dependency, bumped to `^4.3.0`.
- `svgo` and `fast-uri` overridden to `4.0.2` / `3.1.4` — their parents
  (`htmlnano`, `ajv`) already declare wide-enough ranges to permit the
  patched versions but pnpm won't re-resolve a pure-transitive package
  within an already-satisfied range without a forcing mechanism.

The sharp 0.35 bump changed its TypeScript declarations from the old
namespace-merged `sharp.Sharp`/`sharp.Metadata`/`sharp.OutputInfo` pattern to
named exports; `image-display-derivative.ts` updated its type imports
accordingly (no behavior change). It also surfaced a latent bug in this
package's own test fixture (an ancillary PNG chunk type `padA` with a
lowercase reserved-bit byte, which is not PNG-spec-conformant — sharp 0.34's
bundled `spng` PNG decoder tolerated it, 0.35's `libpng`-backed decoder
correctly rejects it); the fixture was corrected to `paDA`, no production
code changed.
