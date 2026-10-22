---
'@crowi/web': patch
---

Keep the "Copy markdown" button on screen down to the same width as the rest of the reading shell. The right rail's breakpoint was tied to whether the page had a table of contents, so a page with few headings lost the whole column — copy button included — at 1440px, while a page with a TOC kept its column down to 1280px. Both now collapse at 1280px, and narrower viewports still reach the action through the page menu as before.
