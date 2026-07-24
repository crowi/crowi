# @crowi/site

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
