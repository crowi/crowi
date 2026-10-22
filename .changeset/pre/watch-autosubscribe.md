---
"@crowi/api": minor
"@crowi/api-contract": minor
"@crowi/web": minor
---

Notifications are now driven solely by explicit page watchers, and participating in a page auto-subscribes you.

Previously the notification audience for comments / likes was an implicit set (the page creator plus everyone who had ever commented or edited the page) unioned with explicit WATCH watchers. A one-time editor of a page they did not watch could therefore keep receiving notifications and could only stop by explicitly ignoring the page.

The audience is now exactly the explicit `WATCH` watchers, minus `IGNORE` opt-outs, minus the acting user, minus inactive users. To keep the effective reach the same while making it controllable, participation now materialises a real watcher row:

- Creating a page or saving a new revision auto-watches the acting user. This covers both HTTP saves and realtime (collab) saves, which flow through the same page-save event.
- Commenting auto-watches the commenter. The add-comment response now returns `newlyWatching: boolean`; when it is `true` the web UI shows a one-shot "you're now watching this page" hint with a stop-watching action.
- An existing `IGNORE` row is always respected — auto-watch never flips an opt-out back to watching.
- Liking a page does not auto-watch.

`getWatchStatus` now reports watch state purely from the presence of a watcher row (the previous derive-from-implicit-set fallback is removed), so the watch toggle is the single source of truth. No schema change; existing pages are not backfilled (auto-watch applies to new activity going forward).
