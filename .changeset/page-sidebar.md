---
"@crowi/api-contract": minor
"@crowi/web": minor
---

Add a left-rail sidebar to wiki pages, mirroring the right-rail table of
contents (same width, sticky offset, and breakpoint). The top section
links to Top / My page / Members / Notifications, plus an Admin shortcut
for administrators.

Below that it shows the current path's ancestry as a single expanded
tree, identical for list (portal) and content pages: each ancestor level
lists its sibling directories and the branch toward where you are is
opened one level deeper, down to the current node — a content page is
highlighted among its siblings, a portal directory is highlighted and
expanded so its own children show below it. A "⤴" affordance above the
root jumps to the parent list page. Navigating from a page to one of its
ancestor portals keeps the surrounding tree in place instead of
collapsing to just that portal's children. Portal directories carry a
compass icon.

Backed by a new `GET /pages/children` endpoint that aggregates the
immediate child segments under a path server-side (respecting page grant
and draft visibility), returning the complete first-level set rather than
a paginated slice.
