---
"@crowi/plugin-api": minor
---

Plugin SDK: add `ctx.appInfo()` to `PluginContext`. It exposes core application info a plugin may need to brand or address outbound integrations — `title` (the configured wiki name, core `app:title`, trimmed and defaulted to `Crowi`) and `baseUrl` (the wiki's public origin, core `CLIENT_URL` / `getBaseUrl()`, empty string when unset). Both fields are non-null, so plugins read them instead of `process.env` directly without writing their own fallbacks; read live at call time, so they reflect admin edits made after boot.
