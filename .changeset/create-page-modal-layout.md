---
"@crowi/web": patch
---

Stabilize the create-page modal layout. The modal is now top-anchored so
the path input stays put around 40% of the viewport instead of drifting
upward as the candidate list grows; the modal extends down toward the
bottom (leaving a small gap) and the candidate list scrolls internally
when there are many matches. Long candidate paths now truncate instead of
overflowing the modal width.
