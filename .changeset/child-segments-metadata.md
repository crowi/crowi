---
'@crowi/api-contract': minor
---

`GET /pages/children` now optionally returns `lastUpdatedAt` and `updater` on each `PageChildSegment`: for a segment that is itself a page, its own last-updated timestamp and updater; for a portal-style segment, the most-recently-updated page in its subtree and that page's updater. Both fields are additive and optional, so existing clients (the web sidebar tree) keep working unchanged; the iOS page list is the first consumer.
