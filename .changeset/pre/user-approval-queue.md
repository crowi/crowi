---
'@crowi/api': minor
---

Add a user-approval queue to the admin panel. When one or more sign-ups are
awaiting administrator approval (status REGISTERED, produced by the Restricted
registration mode), a "User approval" entry appears under User management in
the admin sidebar with a live count badge, linking to a dedicated screen that
lists the pending users and approves them one click at a time. Backed by a new
`GET /admin/users/pending-count` endpoint and a `status` filter on the user
list endpoint.

Invited users now have a deliberately minimal row menu (change email / delete)
and can be removed via a new `DELETE /admin/users/{id}` endpoint, which
physically removes never-activated (INVITED) accounts only.
