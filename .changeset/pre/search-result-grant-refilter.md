---
"@crowi/api": patch
---

`GET /search` no longer trusts the active search driver's grant filtering unconditionally. `Page.findListByPageIds` now accepts an optional viewer id and, when given one, re-applies the same grant `$or` predicate the rest of the app uses (public / legacy-null / pages the viewer is granted on) before returning results. The search handler passes the requesting user's id, so a driver bug, a stale index, or a future third-party `@crowi/plugin-search-*` that forgets to filter by grant can no longer leak a private page's title, path, or snippet into another user's search results.
