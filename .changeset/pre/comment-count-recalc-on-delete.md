---
"@crowi/api": patch
---

Fix `Page.commentCount` not decrementing when a comment is deleted — it was only recalculated on comment creation, so the badge stayed stale (showing a higher count than the actual number of comments) until the next comment was posted.
