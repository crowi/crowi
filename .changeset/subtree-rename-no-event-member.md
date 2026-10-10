---
"@crowi/api": patch
---

Fix a subtree rename reporting failure for pages that actually moved. A page whose history tracking has not started and cannot be started by the rename itself — it has no revision, or its revision pointer fails the ownership check — moves without producing a `page_renamed` event, and a subtree move containing such a page was reported as a deterministic `partial` failure even though every page in the tree had landed at its destination. The member and root operations were also left permanently unfinished rather than settling as completed. A member record that could not be carried by the move at all (its recorded source and destination are the same path) continues to report failure as before; only pages that genuinely moved are affected by this fix.
