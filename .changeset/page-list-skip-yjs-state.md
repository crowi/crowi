---
"@crowi/api": patch
---

Page list rows (page lists, bookmarks, profile pages, search results and recently viewed pages) no longer read each page's stored collaborative-editing state from the database, which can be several megabytes per page. Long lists load faster and use less memory; the response is unchanged.
