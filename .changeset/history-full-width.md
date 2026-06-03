---
'@crowi/web': patch
---

Render the revision-history page (`/_history`) at full viewport width. The
shared `(auth)` layout caps content at `max-w-4xl`, which left the side-by-side
revision diff too narrow — long lines wrapped and changes were hard to read. A
dedicated `_history` layout now breaks out of that column (the same
viewport-wide escape `_edit` uses), without pinning to the viewport height so
the page still scrolls normally.
