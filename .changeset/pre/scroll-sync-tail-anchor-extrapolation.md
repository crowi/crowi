---
'@crowi/web': patch
---

Fix editor↔preview scroll sync jumping backwards and then snapping at the end of a document. Source-line anchors are only injected on top-level block starts, so every line after the last anchor (a trailing list's remaining items, a trailing paragraph's continuation lines, and the editor's bottom padding) collapsed onto that anchor's position. The sliding-reference alignment then moved the preview UP as the editor scrolled DOWN, and the endpoint pin closed the accumulated gap as one visible jump. The line-to-position mapping now extends to the true document edges, so the preview tracks the editor monotonically and reaches the bottom continuously.
