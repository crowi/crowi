---
"@crowi/api": patch
"@crowi/collab": patch
---

Add the first writer for page history (RFC-0021 Phase 2a): every content save (page create, draft create, HTTP update/revert, collaborative editor save, and `crowi-admin replace url`) now assigns a page-local `historySequence` to its Revision, promoting the page's `historyTracking` to `ready` on its first tracked save. Sequence assignment runs as a separate, resumable step after the existing pointer write commits, never as part of it, so a crash between the two never fails the save — a background/operator repair pass recovers any interrupted assignment. `scanUnsequencedRevisions` now skips Revisions younger than a configurable grace window (`RepairScanOptions.minAgeMs`, default 10 minutes) and Revisions predating a page's tracking start, so it never races a still-in-flight assignment or mis-orders history. No request/response shape, status code, error body, or OpenAPI contract changes — this is purely additive bookkeeping invisible to end users.
