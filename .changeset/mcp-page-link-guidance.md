---
'@crowi/api': patch
---

Tell MCP clients how to write a link to a wiki page. The server's instructions covered path shape, page placement and the edit lock, but said nothing about turning a page into a URL — so an assistant handing someone a link had to guess, and a helpful extra round of percent-encoding turns `%20` into `%2520`, which addresses a page name nobody saved. The instructions now name the ID form as the link to prefer, state that a space in a page path is written `+`, and say not to encode a URL that is already a URL.
