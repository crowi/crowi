---
"@crowi/api-contract": minor
"@crowi/web": minor
---

Add a "Create page" modal to the header. Previously the only way to make a
new page was to navigate to an unknown path by hand. The modal lets you
build a `/`-rooted path with Tab-cycle completion against existing pages:
Tab/Shift+Tab cycle through prefix-matching paths (shallowest first) and
write the choice straight into the input, so you can keep typing to reach
the path you want. Paths that already exist are flagged and can't be
re-created; submitting opens the create-mode editor for the new path.

Backed by a new `anchor=prefix` mode on `GET /pages/autocomplete` so the
completion list only contains true prefixes of what the user has typed.
