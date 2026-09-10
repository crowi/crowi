---
"@crowi/api": minor
"@crowi/api-contract": minor
---

`POST /api/pages` and `PUT /api/pages` accept an optional `X-Crowi-Page-Content-Type: markdown | artifact` header (RFC-0020) declaring whether the request body is Markdown source or a self-contained HTML "artifact" document. An artifact body is validated and normalized before it is stored, and `POST /api/pages/revert-to-revision` re-validates a stored artifact Revision the same way before stacking it as a new revision. Omitting the header on a create defaults to Markdown; omitting it on an update keeps the page's current kind. A declared kind that conflicts with a page's existing kind, or a body that fails validation, is rejected before anything is written, with a stable machine-readable reason and no author content echoed back. Writing an artifact page requires an operator to have configured artifact delivery — until then, and until later phases add a way to view a stored artifact page, this only changes what the write API accepts.
