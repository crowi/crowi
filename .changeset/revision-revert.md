---
"@crowi/api-contract": minor
"@crowi/api": minor
"@crowi/web": minor
---

Add revert-to-revision: a one-click "revert to this version" button on the
stale-revision banner (normal + portal pages), a new POST
/pages/revert-to-revision endpoint, and a crowi_revert_to_revision MCP tool.
Non-destructive — the past body is stacked as a new revision, so all history
is preserved and the revert simply lands on top of the current latest.

Also fixes the stale-revision banner never appearing when opening a page at a
past `?revision_id=`: `latestRevision` is a dynamic field set by
`populatePageData`, but `pageToResponse` read it off the `toObject()` result
(which strips dynamic fields), so it was always serialized as `undefined` and
the client could never tell it was viewing an old version. This affected both
normal and portal pages.
