---
"@crowi/web": minor
---

Make the page view's 3-column layout degrade column-by-column instead of
dropping both side rails at once. From 1440px up, the left navigation, the
content, and the right TOC all show (content stays dead-centre as before).
Below 1440px the left navigation hides but the content keeps its TOC.
Below 1280px the right TOC rail collapses into a "目次" button in the page
header (expanded and compact) that opens a popover with the same entries
and scroll-spy highlight — and it stays available all the way down to
mobile. The narrowest layout is otherwise unchanged.
