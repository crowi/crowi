---
'@crowi/web': patch
---

The editor/preview scroll sync now uses a "sliding reference" alignment instead of always pinning the matched line at the viewport top. As you scroll toward the end of the document (the common state while appending text), the alignment point slides down toward the viewport bottom, so the freshly-rendered end of a taller preview stays visible instead of being pushed off-screen. Scrolling to the very top still aligns both panes' tops exactly as before, and the transition in between is continuous — no sudden jump at any point while scrolling either pane.
