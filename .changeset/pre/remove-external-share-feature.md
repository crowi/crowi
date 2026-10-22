---
"@crowi/api": major
"@crowi/api-contract": major
---

Remove the external-share admin feature (admin/share endpoints, app:externalShare config, UI surface). The feature will return as a plugin.

This is a breaking change: the `GET`/`PUT /api/admin/share` endpoints are
unregistered (now 404), the `app:externalShare` config seed key is removed, and
the `externalShare` field is dropped from the `/admin/app` response schema. The
`/admin/share` page and its admin sidebar entry are gone. Page link-sharing
(LinkSharePopover / `page.share.*`) and the dormant Share / ShareAccess models
are kept untouched.
