---
'@crowi/api-contract': minor
'@crowi/api': minor
'@crowi/web': minor
---

Two fixes to the visibility and display of the page list (`/...slug.../`, `/`):

- **Fixed the grant filter on the root / no-path branch**: the old implementation hard-coded `grant: { $in: [1, 2] }`, which (a) dropped the viewer's own GRANT_OWNER / GRANT_SPECIFIED pages, and (b) risked leaking GRANT_RESTRICTED pages to non-members because grantedUsers was not checked. Aligned it to combine the Page model's `visiblePageGrantOr` / `visiblePageStatusOr` with `$and`, unifying the behaviour with the path-based listings.
- **Visual identification of draft pages**: added `'draft'` to `PageStatusSchema` (path-based listings already included the viewer's own drafts via RFC-0004, but the status field couldn't be represented in TypeScript without the enum value, so the badge couldn't be shown). Added an amber "Draft" badge to `PageListItem`, so your own drafts are distinguishable at a glance even when sitting next to published pages.
