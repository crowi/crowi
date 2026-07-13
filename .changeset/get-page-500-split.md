---
'@crowi/api': patch
---

`GET /pages` now returns 500 (`INTERNAL_ERROR`) instead of 404 (`PAGE_NOT_FOUND`) for an unknown error raised after the page was already found — most notably a transient render-artifact/renderer failure — so a client reconciling its cache (or any other caller) can no longer mistake "failed to render" for "page was deleted".
