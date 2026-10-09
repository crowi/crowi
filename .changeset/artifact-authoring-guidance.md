---
"@crowi/api": major
"@crowi/api-contract": major
"@crowi/cli": minor
"@crowi/web": patch
---

Artifact authors now get the link rules before they write and a fixed correction message when a save is refused. The MCP write tools describe the allowed link forms, the query and reserved-route bans, and the `%25` spelling for a literal percent sign, and a rejection carries an optional `diagnosticCode` that REST, MCP and the CLI show the same way. An absolute link to a reserved route is now refused at save time, which also applies when restoring an older revision that contains one; the web "restore this revision" action now shows the rejection reason together with how to fix the body through MCP or the CLI and save it with the current revision ID.
