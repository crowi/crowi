---
'@crowi/web': patch
---

Rename dialog: when it opens, pre-select just the page name (the last path
segment) instead of placing the cursor at the end. You can immediately retype
the leaf without disturbing the parent path — the same affordance as renaming a
file in an editor. Parent folders and the trailing slash of folder paths stay
unselected.
