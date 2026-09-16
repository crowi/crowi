---
"@crowi/api": patch
---

Physically deleting a page (hard delete, redirect stub cleanup during rename/restore, draft cancel, and the compensating delete on a failed draft creation) now also removes that page's WATCH/IGNORE rows and any Backlink row where it is either the link target or the link source, so a deleted page no longer leaves orphaned watcher subscriptions or dangling backlink graph entries behind. The cleanup is best-effort, matching the existing storage-hygiene cleanup already run at the same point in the deletion pipeline: a failure only logs a debug message and never affects the deletion's own success or response.
