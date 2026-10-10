---
"@crowi/api": patch
---

The page-history repair scan (`crowi-admin page-history repair --scan`) no longer jams a page's history outbox when two scans race over the same unsequenced Revision: the claim now reads the page's allocator before re-checking the Revision, so a claim that lost to a concurrent scan is retried instead of committing an entry that could never materialize and burning a sequence number.
