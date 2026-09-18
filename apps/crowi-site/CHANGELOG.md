# @crowi/site

## 0.1.1-alpha.2

### Patch Changes

- d3a10b3: Unify every JWT/HMAC signing secret Crowi issues — Web session access/refresh tokens, OAuth access tokens, OAuth sign-in state, and the realtime collab/presence/notifications/mail tokens — onto a single required `SECRET_TOKEN` environment variable, replacing the previous split between a DB-config-backed `app:secret`/`SECRET_TOKEN` fallback chain for Web/OAuth and a separate `WS_TOKEN_SECRET` for the realtime channels.

  The api now refuses to boot if `SECRET_TOKEN` (or its accepted legacy alias `WS_TOKEN_SECRET`, checked first for backward compatibility) is unset, empty, whitespace-only, or a known placeholder value, in every `NODE_ENV` and regardless of `CROWI_MULTI_INSTANCE` — this closes a gap where a fresh install could sign real user credentials with a public, world-known fallback secret. A non-placeholder value under 32 characters only fails boot in production and only warns elsewhere, matching the existing severity policy the realtime-channel secret already had. Setting both `SECRET_TOKEN` and `WS_TOKEN_SECRET` to different values now logs a boot warning naming which one wins, so a key rotation that adds the new name without removing the old one does not silently keep signing with a leaked value.

  Upgrading invalidates every outstanding Web session access/refresh token, OAuth access token, and OAuth sign-in state cookie that was signed under the old public fallback (the literal `your-secret-key`, which is now itself a rejected placeholder, so it can never be re-entered as `SECRET_TOKEN` to keep those tokens alive) or under a Config-collection `app:secret`/`SECRET_TOKEN` row, since that DB-backed resolution path has been removed entirely and those rows are no longer read; a Config-signed token only keeps verifying if you set the exact same raw value as the new `SECRET_TOKEN`. A deployment that already had a valid `WS_TOKEN_SECRET` is the one case spared automatically: the realtime collab/presence/notifications/mail tokens keep signing and verifying unchanged with that same raw value (including any legacy leading/trailing whitespace), though its Web/OAuth tokens still need the re-authentication above, since they were never signed with `WS_TOKEN_SECRET` before this change. A deployment that had neither variable set won't boot until one is configured, and once it is, every previously issued token is invalidated. OAuth refresh tokens and personal access tokens are unaffected either way, since both are validated against a stored hash rather than a signature. Roll out with a drain-first sequence — stop every old-version replica before starting new-version replicas with the same `SECRET_TOKEN` value — rather than running mixed versions or mixed secret values concurrently.

## 0.1.1-alpha.1

### Patch Changes

- 7353e03: Bump `lucide-react` to 1.x and move it into the pnpm workspace catalog so `@crowi/web` and `@crowi/site` always share one version. lucide 1.x dropped brand-logo icons; the GitHub mark on the public site's home page is now an inlined official GitHub SVG mark instead of lucide's `GithubIcon`. All other icons keep their existing names and only pick up 1.x's minor line-drawing refinements.
- e0dd589: Migrate the last 4 eslintrc-based configs (the repo root, `@crowi/api`, `@crowi/collab`, `@crowi/plugin-search-mongo`) to flat config (`eslint.config.mjs`), so every workspace in the repo now lints through the same config format that `@crowi/web` and `@crowi/site` already used. `eslint` itself moves into the pnpm catalog at `^9.39.5`, so all 7 linted workspaces share one version instead of the previous 8.57.1/9 split.

  This is dev tooling only — no runtime behavior, public type, or API shape changes. Every workspace's lint output was diffed line-by-line against the pre-migration baseline and came back identical (0 errors, same warnings, same files, same line numbers), including `@crowi/api`'s guard rules that block ad hoc test-file DB connections and direct Redis `.duplicate()` calls outside the one helper that installs an error listener first — those guards were restructured from 3 eslintrc override blocks down to 2 flat-config entries (flat config turned out to share eslintrc's "later config replaces, not merges, a repeated rule key" behavior, so the restructuring is a smaller version of the same workaround, not a different one) and their existing regression test (`packages/api/src/test/eslint-db-guard.test.ts`) still passes unmodified assertion-for-assertion, now driving the real flat config via ESLint's Node API with `cwd`-only discovery instead of the removed `useEslintrc` option.

  `eslint` stays on the 9.x series rather than moving to 10: `eslint-config-next` (used by `@crowi/web` and `@crowi/site`) pins `eslint-plugin-react`, whose latest release (7.37.5) calls two APIs ESLint 10 removed outright, so linting a `.tsx` file crashes rather than warns. There is currently no published `eslint-config-next` release that resolves this. Flat config is unaffected by that gap — ESLint 9 already reads it natively — so this migration removes eslintrc from the repo entirely without waiting on the upstream fix; bumping to ESLint 10 later is a single catalog version change once `eslint-plugin-react` supports it.

- a334308: Upgrade TypeScript 5.8 → 6.0 across the whole workspace catalog, plus the two tools whose own peer ranges gated it: `ts-jest` 29.3 → 29.4 (the current version still excluded TS 6) and `@typescript-eslint` 6.21 → 8.68 (moved into the catalog so all five workspaces that declare it directly stay in lockstep). `eslint` itself is untouched, jest stays on the same major, and TypeScript 7 (a native/Go rewrite still landing ecosystem-wide support) is out of scope — this bump is the sanctioned bridge release for that eventual move.

  Runtime behavior and every public type/API shape are unchanged; the generated `.d.ts` output was diffed against the pre-upgrade build across all 316 declaration files and the only differences found were union-member reordering (an internal declaration-emitter artifact, byte-identical content once sorted) with zero content changes.

  Two compiler-level fallouts were absorbed without weakening `strict` or any other type-safety setting:

  - TS 6 hard-errors on two now-deprecated `tsconfig` options that will disappear in TS 7 (`moduleResolution: "node"` and any `baseUrl`, the latter also implicitly injected by `tsup`'s own declaration bundler on every workspace that ships a `.d.ts`). The shared `tsconfig/base.json` now sets `ignoreDeprecations: "6.0"`, which is TypeScript's own documented bridge flag for this exact transitional release; actually migrating off these options is real resolution-strategy work that belongs with the eventual TS 7 move, not this version bump.
  - TS 6 stopped auto-including `@types/*` packages for workspaces using `moduleResolution: "bundler"` unless a tsconfig's `types` array names them explicitly. Several `library.json`-based packages picked up this newly-required `types: ["node"]` / `types: ["jest", "node"]`, matching the explicit-`types` convention several sibling packages (`svg-sanitize`, `admin-cli`, the search plugins, etc.) already used for the same reason.

  `@typescript-eslint` 8's `recommended` preset also added `no-require-imports` (superseding the deprecated `no-var-requires` most call sites already had a justified `eslint-disable` comment for) and tightened `no-empty-object-type` against empty `interface X extends Y {}` declarations. Every new diagnostic was resolved individually: existing suppression comments were extended to cover the new rule name, a handful of genuinely dead/redundant `require()` calls were deleted, two `require()` calls were converted to static imports, and three `Pick<...>`-only marker interfaces became plain type aliases (a mechanical, meaning-preserving rewrite, not a design change).

  `@crowi/web` and `@crowi/site` lint through `eslint-config-next`, which bundles its own `typescript-eslint` dependency rather than reading the workspace catalog. That bundled copy (8.53.0) declared `typescript: >=4.8.4 <6.0.0`, a TS6-excluding range. A `pnpm.overrides` entry (`"typescript-eslint@<8.68.0": "8.68.0"`) forces it to the same 8.68.0 already used directly by the five workspaces above, whose peer range (`>=4.8.4 <6.1.0`) accepts TS 6. No new lint errors surfaced in either workspace after the bump.

  One TS6-excluding tool remains in the graph with no available fix: `openapi-typescript` 7.13.0 (used only by `@crowi/api-contract`'s dev-time OpenAPI-types codegen script, `scripts/generate-openapi-types.ts`) declares `typescript: ^5.x`, and 7.13.0 is still the latest release. This surfaces only as a non-fatal `pnpm install` peer-dependency warning — pnpm does not fail installs on unmet peers by default, and the tool isn't part of `type-check` / `build` / `test` / `lint`. It was verified functionally: `pnpm --filter @crowi/api-contract generate` runs clean under TS 6, and `pnpm check:openapi` confirms the regenerated artifacts are byte-identical to the committed ones. Revisit once openapi-typescript ships a TS6-compatible release.

## 0.1.1-alpha.0

### Patch Changes

- c447269: Bump `next` 16.2.6 → 16.2.11 to clear 9 Dependabot security advisories
  (alerts #638-#664, 3 manifest locations × 9 advisories: `packages/web/package.json`,
  `apps/crowi-site/package.json`, `pnpm-lock.yaml`), all patched in 16.2.11 per
  GitHub's advisory data (vulnerable range `>=16.0.0, <16.2.11` for each):

  - Denial of Service in App Router using Server Actions
  - Middleware / Proxy bypass in App Router applications using Turbopack and single locale
  - Unauthenticated disclosure of internal Server Function endpoints
  - Denial of Service in the Image Optimization API using SVGs
  - Server-Side Request Forgery in rewrites via attacker-controlled destination hostname
  - Unbounded Server Action payload in Edge runtime
  - Cache confusion of response bodies for requests with bodies containing invalid UTF-8 byte sequences
  - Cache confusion of response bodies for requests with bodies
  - Server-Side Request Forgery in Server Actions on custom servers

  Direct dependency bump in both consumers (`@crowi/web`, `@crowi/site`), no
  override needed. No code changes required; type-check/test/build green for
  both packages.
