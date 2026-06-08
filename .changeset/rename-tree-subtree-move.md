---
"@crowi/api-contract": minor
"@crowi/api": minor
"@crowi/web": minor
---

Rename a page together with its whole subtree

`POST /pages/rename` now accepts an `include_descendants` flag. When set, the
page is moved together with every grant-visible descendant under it: paths are
rewritten to the new base, redirects are created from each old (non-portal)
path, and the original timestamps are preserved so a bulk move does not flood
the "recently updated" list. Destination collisions and invalid names are
detected up-front and returned as a structured `PAGE_RENAME_TREE_FAILED` 400
that names the offending paths. The response also reports `renamed_count`.

In the rename dialog, the "move subpages together" switch is now wired up: it
moves the subtree, navigates to the new path, shows how many pages moved, and
lists any conflicting paths on failure.
