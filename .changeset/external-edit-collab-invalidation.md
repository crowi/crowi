---
"@crowi/api": patch
---

Invalidate the collaborative editor's Y.Doc snapshot on external (REST/API)
page edits. `Page.updatePage` now drops `Page.yjsState` and re-points
`currentRevision` to the new revision (RFC-0003 §"Server-side direct Markdown
edits"). Previously an API edit left the stale `yjsState` in place, so opening
the editor restored the pre-edit document and its next autosave silently
reverted the external edit — making the edit appear to "not show" on the page.
