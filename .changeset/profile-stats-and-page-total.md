---
"@crowi/api-contract": minor
"@crowi/api": minor
"@crowi/web": minor
---

`GET /user/{username}` now returns `likesCount` and `commentsCount` alongside the existing `createdPagesCount` / `bookmarksCount` — the number of pages the target user has liked and the number of comments they have written, computed via `countDocuments` on the indexed `Page.liker` / `Comment.creator` fields. These are the target user's own actions, not activity their pages received from others, and are not re-filtered by the viewer's grants.

`GET /pages/list` now returns a top-level `total`: the exact, viewer-visible count of the full (unpaginated) listing, computed with the same match conditions as the page rows themselves and shared across every branch (root, path prefix, `user=`, `/trash`/`include_deleted`). `total` excludes whatever `portalPage` / `contentPage` already excludes from `pages`, so the two never disagree, and stays constant across `offset`/`limit`. `PagerSchema` is unchanged — `total` is a new sibling field, mirroring `ListUsersResponseSchema.total`.
