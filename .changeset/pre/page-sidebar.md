---
"@crowi/api-contract": minor
"@crowi/web": minor
---

Add a left rail mirroring the right-rail table of contents (same width,
sticky offset, and breakpoint). Its shared top section — Top / My page /
Members / Notifications, plus an Admin shortcut for administrators — shows
on every page so it no longer disappears on non-wiki routes; full-bleed
routes (editor / history) opt out, and the member directory and the
`/me`, `/trash`, OAuth, and `_`-prefixed routes show the nav links
without a tree.

Below it, the current path's ancestry renders as a single expanded tree,
identical for list (portal) and content pages: each ancestor level lists
its sibling directories and the branch toward where you are opens one
level deeper, down to the current node — a content page is highlighted
among its siblings, a portal directory is highlighted and expanded so its
own children show below it. The directory you're in always renders as a
labelled node (viewing `/crowi/rfc/0002` surfaces `rfc/` rather than a
bare page list). Navigating to an ancestor portal keeps the surrounding
tree in place instead of collapsing to its children. Portal directories
carry a compass icon.

A user space (`/user/{username}/…`, including the my-page / bookmarks /
created-pages routes) is topped with that user's home as a node — their
avatar (uploaded image, else a generated fallback) — and roots there with
no "⤴", since the roster is reached from the nav links; the member
directory itself is never shown as a tree node.

Backed by a new `GET /pages/children` endpoint that aggregates the
immediate child segments under a path server-side (respecting page grant
and draft visibility), returning the complete first-level set rather than
a paginated slice.
