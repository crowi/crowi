---
'@crowi/api': patch
---

Fix `Page.updatePage` nulling a page's grant on a grant-less update. It computed
`const grant = options.grant || null`, so any call without an explicit grant
(e.g. `updatePage(page, body, user, {})` from `rewritePageBody` and the preflight
migrations that ride it) hit `null != pageData.grant` and re-granted the page to
`null` with `grantedUsers = [actingUser]` — silently dropping a public page out
of `grant: GRANT_PUBLIC` queries. It now defaults to the page's current grant
(`options.grant ?? pageData.grant`), so a body-only update leaves visibility
untouched while an explicit grant change still applies. The HTTP update handler
was already passing `grant ?? pageData.grant` defensively and is unaffected.
