---
"@crowi/api": patch
---

Fix the bookmark list rendering an empty placeholder ring instead of each
page's avatar. `Bookmark.populatePage` populated the page's revision but
not its `creator` / `lastUpdateUser`, so the user fields arrived as bare
ids and the page row had no one to credit. Populate them alongside the
revision, matching the `/pages/list` listing.
