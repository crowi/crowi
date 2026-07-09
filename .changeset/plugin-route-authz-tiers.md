---
"@crowi/plugin-api": minor
"@crowi/api": patch
"@crowi/plugin-slack": patch
---

Plugin SDK: `PluginRouteOptions.public?: boolean` is replaced by `auth?: 'public' | 'user' | 'admin'` (default `'user'`). `makePluginRouterScope` now installs `createJwtAdminRequired` — the same middleware every core `/admin/*` handler uses — for `auth: 'admin'` routes, so plugins finally have a real admin-only tier instead of only "no auth" / "any authenticated user".

BREAKING (pre-1.0 SDK): plugins passing `{ public: true }` must switch to `{ auth: 'public' }`; the `public` field no longer exists on `PluginRouteOptions`.

Fixes a real gap in `@crowi/plugin-slack`: its `POST /manifest` `@action` target (which returns the Slack App manifest, including the wiki's base URL and name) was documented as admin-only but was actually reachable by any authenticated non-admin user. It is now mounted with `auth: 'admin'` and returns `403 ADMIN_REQUIRED` for non-admin users. The Events API webhook keeps `auth: 'public'` (Slack's own request-signature check is its authentication).

Also narrows `@action` annotation parsing (`schema-markers.ts`) to the two verbs a plugin route can actually be mounted on (`GET` / `POST` — `PluginRouteMethod`), so a plugin declaring `@action "..." PUT ...` / `DELETE` no longer produces a silently-dead admin-form button: `getActionAnnotation` still returns `null` for it, and `PluginManager` now logs a boot-time warning identifying the offending plugin and config field.
