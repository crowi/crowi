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
