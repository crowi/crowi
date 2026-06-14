---
'@crowi/api': patch
---

Fix MCP read tools dropping the page body for `structuredContent`-preferring clients. `crowi_get_page` and `crowi_get_revision` (and the write tools that echo back a page) placed the body only in `content[0].text` and exposed just metadata in `structuredContent`. Per MCP convention, clients that prefer `structuredContent` and hide the text block lost the body entirely, falling back to search snippets. The body is now carried in both places (`content[0].text` and `structuredContent.body`, RFC-0011 §9), while the update-lock metadata (`revision_id`, `path`, etc.) is preserved. List/search tools are unchanged.
