---
"@crowi/web": patch
---

Opening a URL that sends you on to another one no longer leaves a focus ring drawn around the whole page. This covers all three: a page's id URL (`/<page id>`), a path a page was renamed away from, and a link that arrived double-encoded and had to be recovered. Moving between pages with the keyboard still puts focus, and its ring, on the page content as before.
