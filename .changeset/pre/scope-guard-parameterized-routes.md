---
"@crowi/api": patch
---

Fix an authorization bypass where PAT / OAuth token scope guards were silently skipped on every parameterized route (e.g. `GET /user/{username}`, `GET /user/{username}/pages`, `GET /user/{username}/bookmarks`). `applyScope` registered the guard on the OpenAPI path form (`{username}`), which Hono's router treats as a literal segment that never matches a real request, so the required-scope check never ran and a narrowly-scoped token could reach those handlers. It now attaches the guard on the route's Hono routing path (`:username`) — the same path the handler is registered on — so the scope check runs. Non-parameterized routes (e.g. `/me`) were unaffected.
