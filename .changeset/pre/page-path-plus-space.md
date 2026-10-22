---
"@crowi/web": minor
---

Render spaces in wiki page paths as `+` in the URL instead of the noisy
`%20`, and read `+` back as a space — restoring the legacy Crowi
convention. Visiting
`/Weall/dev/infra/v0/mysql+connect+to+production+db` now opens the page
`/Weall/dev/infra/v0/mysql connect to production db`, and every in-app
link / navigation to a page with spaces (lists, search, backlinks,
breadcrumbs, sidebar, notifications, rename / restore / delete redirects)
produces the readable `+` form. Stored paths and the API are unchanged —
the conversion happens only at the Next.js routing boundary, mirroring the
server-side `[[wiki link]]` handling. As in legacy Crowi, a literal `+`
cannot appear in a page path (it is always read as a space).
