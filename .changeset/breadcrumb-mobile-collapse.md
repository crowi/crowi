---
'@crowi/web': patch
---

Fix the page breadcrumb overflowing the viewport on mobile. A deep page path
previously ran off the right edge of narrow screens, leaving the trailing
ancestors clipped and unclickable. The breadcrumb now collapses the middle
ancestors behind a `…` dropdown below the `md` breakpoint — keeping Home, the
first level, and the immediate parent on a single line, with the hidden levels
still reachable from the dropdown. From `md` up the full trail keeps rendering
inline, so desktop is unchanged.
