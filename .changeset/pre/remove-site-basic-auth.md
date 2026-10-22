---
'@crowi/api': major
---

Remove the legacy site-wide HTTP Basic auth feature. The `security:basicName` /
`security:basicSecret` settings are gone from the admin Security screen and from
the `GET`/`PUT /admin/security` request and response shapes (breaking change).
The credentials were never re-implemented as enforcement in the Next.js + Hono
architecture — they were a settings-only carryover from the legacy Express app —
and in a single-page app a server-side Basic-auth challenge cannot reliably gate
the UI anyway. Operators who need a site-wide Basic-auth gate should configure it
at their reverse proxy. Any existing `security:basicName` / `security:basicSecret`
config rows are simply ignored.
