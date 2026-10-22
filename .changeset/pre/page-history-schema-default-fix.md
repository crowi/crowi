---
"@crowi/api": patch
"@crowi/admin-cli": patch
---

Fix page history tracking being undone by a content save, which could give two revisions of the same page the same sequence number, and fix pages with an explicit null history counter never starting to record history.

A save made from a stale copy of a page that another request had just promoted wrote the default tracking state back, so the page fell back to untracked and the next save sequenced a second revision as number 1. The two history fields no longer have schema defaults, so a stale save leaves them alone, and a content save no longer promotes a page that already holds sequenced history. `crowi-admin page-history repair --scan` now finds pages that fell back this way, puts them back to tracked when their sequence numbers are free of duplicates (reported as restored), and reports the rest as blocked without changing them. After upgrading, run `crowi-admin page-history repair --outbox --scan` once.
