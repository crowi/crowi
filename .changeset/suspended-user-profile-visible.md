---
"@crowi/api": patch
---

Show suspended users' profile pages instead of 404ing them.

`/user/:username` (and its `/bookmarks` + `/pages` siblings) returned
`USER_NOT_FOUND` for any non-active account, which swept up suspended users. But
a suspended author's pages stay visible in the page tree under
`/user/<username>/...`, so hiding only their profile produced a broken "User not
found" landing page. Active and suspended accounts are now shown; deleted
(tombstoned) and invited / registered placeholder accounts remain hidden behind
the same 404. The member directory (`/users`) is unchanged and still excludes
suspended users.
