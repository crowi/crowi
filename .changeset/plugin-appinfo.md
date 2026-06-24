---
"@crowi/plugin-api": minor
---

Plugin SDK: add `ctx.appInfo()` to `PluginContext`. It exposes core application info a plugin may need to brand outbound integrations — currently `{ title }`, the configured wiki name (core `app:title`) trimmed and defaulted to `Crowi`, so plugins always receive a non-empty name without writing their own fallback. Read live at call time, so it reflects admin edits made after boot.
