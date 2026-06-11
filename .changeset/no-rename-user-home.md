---
"@crowi/api": patch
"@crowi/web": patch
---

Disallow renaming a user's home page (`/user/<username>`). Its path is bound
to the username, so the rename action is now hidden in the page menu and the
rename API rejects it with 400 PAGE_INVALID_NAME (mirroring the existing
delete guard). Pages under the home (e.g. `/user/<username>/memo`) are
unaffected.
