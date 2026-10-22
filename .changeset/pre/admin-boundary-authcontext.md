---
"@crowi/api": patch
---

Enforce that `/admin/*` routes only accept web-session authentication, closing a gap where an admin's own PAT or OAuth access token could reach admin endpoints.

`createJwtAdminRequired` now rejects any request whose `authContext.kind` is not `web` with the existing `403 ADMIN_REQUIRED` response, before checking `user.admin`. RFC-0010 reserves `admin:*` scopes so no PAT/OAuth token is meant to carry admin access — this closes the gap where a scoped, non-admin-intent PAT issued by an admin user could still reach every `/admin/*` endpoint regardless of its scopes. Web-session admin requests (the existing UI flow) are unaffected; non-admin requests keep their existing `403 ADMIN_REQUIRED` behavior.
