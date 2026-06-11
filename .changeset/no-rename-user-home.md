---
"@crowi/api": patch
"@crowi/web": patch
---

Disallow renaming a user's home page (`/user/<username>`). Its path is bound
to the username, so the rename action is hidden in the page menu and the
rename API rejects it with 400 PAGE_INVALID_NAME (mirroring the existing
delete guard). The guard covers every route into a rename: the single-page
rename (source and destination — a page can't be moved *onto* a home path
either) and the folder/subtree move (a `/user/` subtree that would sweep in
every home page is refused). Pages under the home (e.g.
`/user/<username>/memo`) are unaffected.
