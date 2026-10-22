---
'@crowi/web': patch
---

Added an icon indicator to GRANT_RESTRICTED ("anyone with the link") pages. Previously only SPECIFIED / OWNER were distinguished with a Lock icon, leaving RESTRICTED indistinguishable from public. A Link2 icon is now shown at the start of the row in PageListItem and in PageHeader (both expanded and sticky), visually separating "anyone the link was shared with can view" from "only listed users".
