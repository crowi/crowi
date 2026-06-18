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
