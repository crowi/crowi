---
"@crowi/api-contract": minor
"@crowi/web": minor
---

Add a left-rail sidebar to wiki pages, mirroring the right-rail table of
contents (same width, sticky offset, and breakpoint). The top section
links to Top / My page / Members / Notifications, plus an Admin shortcut
for administrators. Below that it shows a path-aware hierarchy:

  - On a list / portal page: the first-level directories directly under
    the current path (portal directories carry a compass icon).
  - On a single page: the page's ancestry as an expanded tree — each
    ancestor level lists its siblings and the branch toward the current
    page is opened down to the page itself, with a "⤴" affordance to
    jump up to the parent list page.

Backed by a new `GET /pages/children` endpoint that aggregates the
immediate child segments under a path server-side (respecting page grant
and draft visibility), returning the complete first-level set rather than
a paginated slice.
