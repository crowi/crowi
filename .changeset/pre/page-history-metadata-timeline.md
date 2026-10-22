---
"@crowi/api-contract": minor
"@crowi/api": minor
"@crowi/collab": minor
"@crowi/admin-cli": minor
"@crowi/web": minor
---

A page's history now shows what happened to the page itself, not just its content. Renames, visibility changes, moves to the trash, restores and draft publishes appear as their own rows — who did it and when — interleaved with the content revisions in the order they happened, on one timeline (RFC-0021). Each row carries the concrete detail behind it: a rename names the old and new paths and whether a redirect was left behind, a visibility change names both sharing levels, and trash and restore rows name the path the page left or returned to. Comparing revisions works as before — only content rows are selectable, and the default comparison still opens on the most recent change. A new `GET /pages/{pageId}/history` endpoint backs the screen, paginated by an opaque cursor and readable by anyone who can read the page. Pages whose history predates this release keep showing their revisions, simply without a position in the metadata ordering, and users who have since been deleted or suspended appear as an unknown user rather than by name.

**Clients other than the built-in UI must be updated before upgrading.** `POST /pages/rename`, `POST /pages/rename-subtree`, the soft-delete branch of `DELETE /pages`, and `POST /pages/revert` now require an `Idempotency-Key` header. Each of those runs as a durable operation: a repeated delivery of the same request returns the current page with `Idempotency-Replayed: true` instead of moving anything twice, and the same key sent with a different destination is refused with 409 `IDEMPOTENCY_KEY_CONFLICT`. Hard delete and internal callers such as user-page activation are unchanged and record nothing.

**Replace every api replica at once when upgrading to this version rather than rolling them.** While a page is between the two writes of a move it is briefly excluded from reads, listings and search rather than being served under an ambiguous path, and a replica running an older version does not recognise that state — it can start a second move on top of one already underway, leaving both unfinished. A single-instance deployment satisfies this automatically. A move interrupted by a crash leaves the page in that recoverable state, and `crowi-admin page-history repair --transitions` settles it or reports it with the operation, page and path so an operator can act; it never rewrites a page whose state it cannot classify.

Hard-deleting a page or cancelling a draft purges that page's history events, so a deleted page's history never outlives it. Page creation and draft cancellation deliberately record nothing. Page content, search indexing, backlinks, notifications and live-collaboration updates are unaffected.
