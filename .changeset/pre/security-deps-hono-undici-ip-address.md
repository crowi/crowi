---
'@crowi/api-contract': patch
'@crowi/plugin-api': patch
'@crowi/api': patch
---

Security dependency updates. `hono` moves to `4.13.0` (the declared floor is now `^4.12.34`, the first release without GHSA-advisory-affected versions) — for `@crowi/plugin-api` this also raises its `hono` peer range, so a plugin pinning an older 4.12.x will need to move up. Transitively, `undici` 7.x reaches `7.29.0` and `ip-address` reaches `10.4.0`, both within their existing parents' ranges. No `pnpm.overrides` entries were needed for any of these.
