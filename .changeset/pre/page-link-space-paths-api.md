---
"@crowi/api": patch
---

`POST /pages` now rejects a `path` containing a literal `+` with `400 PAGE_INVALID_NAME`, matching the existing draft-creation and rename checks — previously this one creation path let through a page whose path became unreachable by URL for anyone but its creator (Crowi's URL convention always reads `+` as a space). Angle-bracket links (`[label](</foo bar#frag>)`) now correctly strip a trailing `#fragment`/`?query` before backlink lookup, so their Backlinks panel entry matches the real page instead of silently failing to find one. A single malformed percent-encoded link (e.g. `/a%`) in a page's body no longer wipes out that page's other, well-formed backlinks — link extraction is now hardened per-link and runs before existing backlinks are removed.
