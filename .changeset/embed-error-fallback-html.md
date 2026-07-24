---
'@crowi/plugin-api': minor
'@crowi/api': minor
---

Give renderer plugins a first-class way to show a working fallback UI on render failure, and make the plugin-render cache keep the last-good output on screen through a transient failure.

`@crowi/plugin-api`'s `RenderResult` gains an optional `errorHtml` field, paired with `error`: when set, `@crowi/api` shows `errorHtml` instead of the generic link-less placeholder, and a new `RenderError.code: 'blocked'` covers policy-level permanent rejections (SSRF block, disallowed scheme, disallowed content-type) with the same 1h TTL as `not_found`. `@crowi/api`'s plugin-render cache also adds a stale-if-error policy: when a previously-successful embed or code-block render's background/blocking revalidation fails, the last-good output stays on screen (retried at the failure's own TTL cadence) for up to 24h before degrading to `errorHtml` or the placeholder — this applies uniformly to every renderer plugin, not just link cards, so e.g. a PlantUML diagram no longer drops to a placeholder while the PlantUML server briefly restarts.

Crowi's `@[card](url)` link-card embed (originally shipped as the separate `@crowi/plugin-renderer-link-card` plugin, since folded directly into `@crowi/api` core — see the emoji/link-card core-absorption changeset) migrates its failure path onto this real contract instead of disguising every OGP-fetch failure as a successful render with a plugin-local shortened TTL: per-failure-class TTL (persistent 1h for blocked/not-found sources, transient 5min for network/timeout, `Retry-After`-aware rate-limit handling) is now expressed through the shared `error` + `errorHtml` mechanism, so admin telemetry sees the real failure instead of a fake success. The `errorHtml` a link-card render shows today is the unified fallback card described in the emoji/link-card core-absorption changeset — a plain link to the original URL with no error-red styling, not a dedicated error card.
