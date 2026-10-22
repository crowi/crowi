---
"@crowi/api": minor
"@crowi/api-contract": minor
"@crowi/web": minor
---

Add a "Subpages" tab to the user page.

`/user/<username>` now has a third footer tab, "Subpages", listing every page that actually exists under `/user/<username>/` (recursively, across all depths), regardless of who created it — distinct from the existing "Pages" tab, which lists pages this user created regardless of path. The preview shows up to 10 rows plus the total count, with a "View all" link to `/user/<username>/pages` for the full, paginated listing (30 per page). Visibility follows the same grant/status rules as every other page listing.

Also hardens draft creation (`POST /pages/drafts`): if the seed revision fails to save after the draft `Page` document was created, the orphaned `Page` is now compensating-deleted so it can no longer resurface as a permanently broken row in listings such as the new Subpages tab.
