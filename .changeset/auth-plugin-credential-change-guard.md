---
"@crowi/api": patch
---

Saving an auth provider plugin's credentials (e.g. `@crowi/plugin-google`'s OAuth client id/secret) from `/admin/plugins` now requires confirmation when users are already linked through that provider. The save returns a 409 with the number of linked users; resubmitting with `confirmLinkedIdentities: true` proceeds. The admin UI shows a confirmation dialog with the count and re-sends automatically when confirmed. Saves that touch only unrelated settings, plugins with zero linked users, or plugins that register no auth driver are unaffected.
