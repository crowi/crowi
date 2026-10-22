---
"@crowi/api": patch
"@crowi/web": patch
"@crowi/api-contract": patch
"@crowi/collab": patch
---

Artifact pages can no longer be edited by mistake as Markdown: the Web hides every body-edit entry for an artifact page and shows a notice that points to the CLI or MCP when its edit URL is opened directly, and the server now checks the current revision's type on every body save (including internal writers and the realtime collaboration save path) so an artifact body is only stored together with a validated HTML write, while CLI / MCP updates that omit the type, version restore, history, download, rename and permission changes keep working.
