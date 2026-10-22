---
"@crowi/admin-cli": minor
"@crowi/api": minor
---

Add `crowi-admin watcher backfill` for pages created before auto-watch.

Auto-watch only materialises WATCH rows for participation going forward
(create / edit / comment), and the notification fan-out is now watcher-only, so
pages that predate the feature have no watcher rows and their past participants
stop being notified. The command walks every non-redirect page and creates a
WATCH row for its implicit notification set (creator + comment authors +
revision authors), respecting existing IGNORE opt-outs and leaving existing
WATCH rows untouched. Idempotent; supports `--dry-run`.
