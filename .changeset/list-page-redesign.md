---
'@crowi/web': minor
---

Redesigned the page list (the list page at trailing-`/` paths) for scannability. Each row is now a title-first two-line layout that brings the last path segment forward as the page name and groups the directory path, author, and updated time into a muted second line. Like / comment counts are right-aligned so they form columns, making cross-row comparison easy. A layout-matching skeleton is shown while loading.

When a portal page exists, its body and page actions (rename / delete / like / bookmark / watch) are shown as before, marked with a "Portal" label.

Added a renameTree UI to the rename dialog for moving the subpages underneath as a batch (subtree count display + move preview). Executing the batch move is guarded until the backend supports it; for now only a single page can be moved.

Made the page-name display logic date-hierarchy aware. A path whose tail is consecutive numeric segments, like `/user/foo/diary/2026/05/23`, displays "2026/05/23" rather than "23" as the page name everywhere — in the list, the page-header H1, and the browser tab title. This is a faithful display-side expression of Crowi's path-based page-name design — the structure where `/diary/2026/` shows a per-year list and `/diary/2026/05/` a per-month one.

Rewrote the user-profile "created pages" / "bookmarks" listings (the `/user/<name>` tabs, `/user/<name>/recent-create`, `/user/<name>/bookmarks`) on the same shared primitives as the list page (`PageRowsCard` / `PageRowsSkeleton` / `PageListSectionHeader` / `PageListEmptyCard` / `LoadMoreButton`), unifying the look of rows, card padding, skeletons, count display, and empty states. At the same time the default page sizes were raised — list 50 → 100, user listings 10 → 30 — to match the post-redesign density.
