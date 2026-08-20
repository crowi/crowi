---
"@crowi/api-contract": patch
"@crowi/api": patch
"@crowi/web": patch
---

A page's history screen now shows its metadata changes alongside its content revisions, in one timeline (RFC-0021 Phase 3). Renames, visibility changes, moves to the trash, restores and draft publishes appear as their own rows — who did it and when — interleaved with the revisions in the order they happened. Comparing revisions works as before: only content rows are selectable, and the default comparison still opens on the most recent change. Pages whose history predates this feature keep showing their revisions; those older revisions simply carry no position in the metadata ordering, and pages that have never recorded metadata history are unaffected. A new `GET /pages/{pageId}/history` endpoint backs the screen, paginated by an opaque cursor and readable by anyone who can read the page — a page that is momentarily mid-move is hidden from it exactly as it is from ordinary page reads. Users who have since been deleted or suspended appear as an unknown user rather than by name.
