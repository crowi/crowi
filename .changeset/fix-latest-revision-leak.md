---
'@crowi/api': patch
---

Fix `POST /pages` and `PUT /pages` responses leaking a full stringified Revision document (including another user's id, the full page body, and internal fields) through the `latestRevision` field instead of returning its id as a plain string.
