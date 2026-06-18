---
'@crowi/plugin-api': minor
---

Plugin SDK: `registerRoutes(scope, ctx)` now mounts plugin-contributed HTTP
routes on Hono at `/api/v2/plugins/<name>/<path>`. The previous no-op stub is
replaced by a real surface: `scope.route(method, path, handler, opts?)` takes a
plain Hono `Context` handler, with a `public` flag (bypass Crowi auth for
self-authenticating webhooks) and a guaranteed raw-body access (no body-consuming
validator runs ahead of the handler, so `c.req.text()` / `c.req.raw` yield the
exact bytes the client sent) for HMAC signature verification. The `<name>` path
segment isolates each plugin from core endpoints and from other plugins.
