---
'@crowi/api': minor
'@crowi/api-contract': minor
'@crowi/web': minor
'@crowi/plugin-api': minor
'@crowi/runner': patch
---

Absorb the emoji shortcode transform and the `@[card](url)` link-card embed directly into `@crowi/api` core — both are now always-on Markdown features and no longer need to be installed as separate renderer plugins (`@crowi/plugin-renderer-emoji` and `@crowi/plugin-renderer-link-card` are unreferenced now and will be removed from the workspace in a later release).

Link-card OGP fetching is controlled by a new admin Security setting, "Allow link cards for external URLs" (default ON, matching the previous plugin-installed behaviour and GitHub/Slack/Notion-style link unfurling). Disabling it stops all new outbound OGP requests immediately — including bypassing the render cache entirely, so a card fetched while enabled is never served stale after a disable, and a disable never leaves a cached fallback behind after a re-enable — and every render that cannot show a real preview (a disabled toggle, a fetch failure, a blocked/air-gapped host) now shows the exact same non-error-styled fallback card (a plain link to the original URL) instead of the old dedicated error-card variant.

Operators upgrading with `@crowi/plugin-renderer-emoji` or `@crowi/plugin-renderer-link-card` still listed in `crowi.config.json` see a one-time boot warning instead of a hard failure — remove the two entries (and the matching `dependencies`) once convenient; they no longer do anything.

`@crowi/plugin-api`'s `EmbedRenderer` gains an optional `shouldBypassCache(input)` hook — a renderer whose output depends on a runtime policy toggle (like link-card's) can use it to skip the render cache entirely for a given dispatch instead of only checking the toggle inside `render()`, which would otherwise let a stale cache hit serve pre-toggle output.
