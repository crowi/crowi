---
"@crowi/api": patch
---

Make `onInstall` install-once and idempotent, matching the `@crowi/plugin-api` SDK contract.

`PluginManager.activate()` previously called every plugin's `onInstall(ctx)` unconditionally on every boot, even though the SDK's TSDoc already promised "idempotent — the runtime tracks which plugins have already had `onInstall` invoked and skips on subsequent boots." A plugin author who writes a one-shot legacy config migration in `onInstall` (the documented use case) would see it re-applied on every restart, and any operator edits made after boot would get clobbered by the migration re-running. `activate()` now checks a new `plugin-installed` Config namespace (`plugin-install-tracker.ts`) before calling `onInstall`, and only records the plugin as installed after `onInstall` completes without throwing — a failed `onInstall` is retried on the next boot instead of being silently marked done. No first-party plugin implements `onInstall` yet, so this closes the contract gap ahead of any real usage rather than fixing an observed regression.
