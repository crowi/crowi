---
"@crowi/web": minor
"@crowi/api": patch
"@crowi/plugin-search-elasticsearch": patch
"@crowi/plugin-search-opensearch": patch
"@crowi/plugin-search-mongo": patch
---

Viewing an HTML artifact page (RFC-0020) now reads and operates like the rest of Crowi instead of standing out as a special case. The page body widens to use the space the table-of-contents rail would otherwise occupy (with the rest of the page — comments, backlinks, attachments — staying at the normal reading width). The page menu drops "Copy markdown" and "Make this a portal" (neither means anything for HTML) and replaces "Download markdown" with "Download HTML", which always saves the file as a browser download rather than opening it; history, rename, delete, like, watch, share, and comments all still work exactly as they do on a Markdown page. Page lists and search suggestions mark an artifact page with a small icon next to its title (not a status pill, since being an artifact is a permanent trait of the page, not a temporary state).

Search treats an artifact page's HTML body as non-text: it is excluded from the search index on every backend (the built-in MongoDB search, Elasticsearch, and OpenSearch), so a keyword that only appears inside the markup will not match it, and a result row for it only ever shows a snippet when its path is the match. The page itself is still fully findable by its path and title.
