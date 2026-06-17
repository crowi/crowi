---
'@crowi/api': patch
'@crowi/web': patch
---

Reserve the `/api` namespace so it is never treated as a wiki page. Visiting
`/api` (or any non-proxied `/api/*`) in the web app previously fell through to
the page catch-all and offered the "create this page" UI, because only
`/api/v2/*` is reverse-proxied to the api. The bare `/api` segment now renders a
404 instead, and the server's `Page.isCreatableName` refuses to create or rename
a page under `/api` (mirroring the existing `admin` / `me` / `files` / … reserved
prefixes). The match is segment-bounded, so a real page like `/apiary` stays
creatable.

The web catch-all's reserved-path guard now mirrors the full set of server
top-level reserved prefixes (`installer` / `register` / `login` / `logout` /
`admin` / `me` / `files` / `trash` / `paste` / `comments` / `api`), so the
"create this page" affordance is no longer offered for any path the server
would reject. `/user` is intentionally excluded — it renders the member
directory.

For wikis upgrading from v1 (where the API lived at `/_api/*`, leaving `/api/*`
a valid page path), a new `relocate-reserved-api-paths` preflight migration
moves any surviving page out of `/api/*` into `/api-legacy/*` so the v2
reservation does not strand it. Run it with `crowi-admin migrate apply`; wikis
with no `/api/*` pages have nothing to apply.
