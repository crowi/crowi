---
'@crowi/api-contract': minor
'@crowi/api': minor
'@crowi/web': minor
---

Improve the page-list / portal / sidebar UX and add a "portalize" flow.

- **Empty-list "Create page" CTA**: an empty folder listing — or a portal whose
  child list is empty — now shows a "Create page" button (pre-filled with the
  current path), instead of dropping the create affordance. Hidden in trash, at
  the root, and in other users' spaces.
- **Unified sidebar tree for `/x` and `/x/`**: a content page and its portal
  twin now render the identical sidebar tree, and the current node always
  expands its own children, so navigating between a page and its portal no
  longer reshuffles the tree.
- **Portalize a content page**: the page "⋮" menu gains "Make this a portal",
  which moves `/some-page` → `/some-page/` (leaving no redirect behind). Opening
  `/some-page/` while a content page lives at `/some-page` now offers the same
  one-click portalize banner instead of "Create Portal". `GET /pages/list` gains
  a `contentPage` field to drive this.
- **No more `/x` ↔ `/x/` double-state**: when one of the trailing-slash twins
  exists, creating the other is refused (editor draft creation, `POST /pages`,
  and rename all return 400 — `PAGE_TWIN_EXISTS` on the page endpoints). A
  self-portalize (`/x` → `/x/`) is still allowed. Existing double-state data is
  left untouched.
- **Reach a content page that is also a folder**: when a content page at `/x`
  also has descendants under `/x/…`, the sidebar now lists `/x` itself as the
  first child under the `x/` folder (it was previously unreachable, since the
  folder node links to the `/x/` listing). The path in the "there is content
  at this path" banner is now a link to that page, and viewing the content
  page `/x` directly shows a "this page has descendants — make it a portal?"
  banner.
