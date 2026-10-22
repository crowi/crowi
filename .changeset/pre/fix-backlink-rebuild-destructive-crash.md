---
"@crowi/api": patch
---

`crowi-admin rebuild backlink` no longer destroys the backlink index when a page has no revision. The rebuild deleted every backlink up front and then crashed on the first page whose revision was missing, leaving the instance with no backlinks and no working way to restore them — the rebuild is itself the documented recovery path. It now resolves every link before deleting anything, so a failed run leaves the previous backlinks in place, and pages without a revision are excluded from the scan.
