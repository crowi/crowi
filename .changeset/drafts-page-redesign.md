---
'@crowi/web': minor
---

Redesigned `/me/creating-pages` (pages in progress) from its information architecture up. Drafts are unpublished triage targets — the layout now prioritises answering "is this still live work?" and "keep it or discard it?" at a glance, so the row structure and actions were rebuilt.

- Two-line row layout: path (mono / link to the editor) on top, then created-at · last-edited-at. `updatedAt` was previously unused and is now surfaced, but is omitted right after creation (within 1 minute) where it would be redundant. `Page.updatedAt` is advanced by the Hocuspocus compaction store, so it keeps moving during Yjs editing.
- Row-end actions are two icon-only ghost buttons (edit / cancel), cutting the row height down from the previous two labelled outline buttons.
- The "start a new page" form changed from a heavy Card+Header+Description+Body structure to a lightweight inline panel toggled by a "+ New page" button in the header. This also removes the duplicated copy where the H1 subheading and the form description said the same thing twice.

Body preview / character count was intentionally left out: a draft's body lives in the Hocuspocus Y.Doc / `Page.yjsState` as the source of truth, and `Page.revision.body` only reflects it on an explicit save. Reconstructing the Y.Doc from the listing could show it accurately, but the cost isn't worth it, so the two-line layout was kept.
