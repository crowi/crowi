---
"@crowi/api-contract": patch
"@crowi/api": patch
"@crowi/web": patch
"@crowi/cli": patch
---

Page list rows (page lists, bookmarks, profile pages, search results and recently viewed pages) no longer load or return the latest revision's body, rendered AST and metadata, which makes long lists lighter and faster. The revision object is still present on each row with its id, path, author and content type; fetch the page itself to read its body. The portal page shown above a list is unchanged, and `crowi recent --json` and `{{revision.body}}` templates no longer include the body.
