---
'@crowi/api': minor
---

Rewrite v1 `/files/<id>` attachment URLs in page bodies to the v2
`/api/v2/attachments/<id>` form via a new `files-url-to-attachments` preflight
migration, and restore a `/files/:id` → 302 redirect as a runtime safety net.

In v1, attachments and images were embedded in page bodies as `/files/<24hex>`
(relative, or `https://<host>/files/<id>` when the editor pasted a full URL).
v2 serves attachments from `/api/v2/attachments/<id>` and the legacy
`/files/<id>` route was removed with the Express host, so every such embed now
404s — the image is broken. The attachment id is unchanged between v1 and v2, so
this is a pure URL rewrite (no id remap): the migration converts relative
`/files/<id>` unconditionally, relativizes self-host absolute URLs (matched
against `CLIENT_URL` / `BASE_URL`), and leaves external hosts untouched to avoid
clobbering third-party images. Markdown image and link syntax are covered; the
rewrite is idempotent and reports affected pages via `detect`. When neither
`CLIENT_URL` nor `BASE_URL` is set, only relative URLs are converted.

As a safety net for un-migrated bodies and relative `/files/<id>` runtime
accesses, a public `/files/:id{[0-9a-fA-F]{24}}` route now issues a 302 redirect
to `/api/v2/attachments/<id>`; authorization is delegated to the (JWT-guarded)
redirect target.
